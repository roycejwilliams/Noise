// The member snapshot, built in SHADOW (snapshot design 2026-10-29, ~/cue-worktrees/notes/snapshot-design-1029.md §2 and §4; rollout
// step 2). Nothing reads it yet: no reply, read or check path imports this file (evals/snapshot/snapshotBuild.ts checks that). It is
// built, stored and measured so step 3 can switch the reply onto it with numbers in hand.
//
// What it is: one rendered text per member, built by CODE (no model call) from the fenced memberKnowledge assembler, the co_facts
// ledger (rows with meta.ledger, PR 1) and the member's own tables. A cache, never a source: rebuildable from the stores at any time,
// and nothing writes back from it. Every line is an entry with a stable id (a section letter and the source row's own id, or a short
// hash of its words where the assembler gives no id), a date and a provenance tag: said (their words), seen (Cue observed it),
// did (Cue's own action), inferred (Cue's read, which never backs a claim).
//
// Sections (rendered tokens, estimated at CHARS_PER_TOKEN; total cap 40k):
//   1 words     In their own words: profile, corrections, claims, preferences, limits                          6k
//   2 middle    What they're in the middle of: threads, goals, asks, open loops, what's in the way               8k
//   3 feelings  Feelings and how they text: emotion signals, lessons from pushback, texting style              3k
//   4 world     Their world now: tasks, briefs, documents, promises, scheduled calls                            5k
//   5 ledger    What Cue has done: the action ledger, newest first                                              12k
//   6 can       What Cue can do: the capability sheet (team-only lines for the team only)                       2k
//   header      version and zone, and their first name. Never the clock: the time goes in the tail.             <0.5k
// Not in it (they go in the uncached tail, step 3): the recent thread, this message, the time, this turn's receipts, per-turn
// instructions, and anything computed against the clock (restraint holds, "due" states, today's event).
//
// Staleness (services/memberSnapshotSchema.ts): every write to a source table leaves a mark for the member inside the writer's own
// transaction. readSnapshot rebuilds before returning when any mark is there, when there's no row yet, or when the row is older than
// 24h. LEARN (routes/sendblue.ts, after the turn's learning writes land) rebuilds and stores version N+1, and the upkeep job rebuilds
// any stored snapshot that is stale, so a removal leaves the stored row within one pass even though nothing reads it yet.
//
// Guarantees:
//   - the fence: every sentence naming a linked member (any word of their full name, linkedFullNames) becomes a details-free, nameless
//     history line (safeMemory's policy), their own words included, and the build
//     then asserts that no linked name and no other member's user id is left anywhere in the body. A hit fails closed: nothing is
//     served (no older version either), the row is stored blocked with no body, and snapshot.fence_block is logged (counts only).
//     A name read that fails fails the build the same way. Another member's details may later enter only on a line backed by a share
//     consent row (consent_id); no such source exists yet, so no line is exempt.
//   - forgetting: the builder reads the live guards (whatCoKnows forgottenRows) and applies them to every line once, with guardText
//     semantics (a safety line is kept whole); a guard read that fails fails the build. A removal marks the snapshot stale in the
//     writer's transaction through the trigger, so the next read rebuilds.
//   - size: each section has its budget. Past it, the OLDEST closed entries are collapsed into dated count lines that keep their source
//     ids. Open items (asks, threads, goals, tasks, loops, promises, scheduled things) are never collapsed: if they alone overflow, the
//     section overflows and snapshot.over_budget is logged. The builder asserts entries in = entries rendered + entries collapsed; on a
//     mismatch nothing is stored and the previous version stays.
// The collapse line here is code (counts and ids). For their-words sections the design has LEARN write a summary with its source ids;
// that is the learning prompt's change (step 7), not this one.
import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { Pool, type PoolClient } from "pg";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { capabilitySheet } from "./capabilities.js";
import type { MemberKnowledge, KnowledgeSection } from "./memberKnowledge.js";
import { nameFinder, namelessHistoryLine, WORD_NAMES } from "./memberSafeMemories.js";
import { wordsZone } from "./memberTime.js";
import { forgets, guardText, type ForgottenRow, type Guarded } from "./whatCoKnows.js";

// ---------------------------------------------------------------- shape

export type Prov = "said" | "seen" | "did" | "inferred";
export type SectionId = "words" | "middle" | "feelings" | "world" | "ledger" | "can";
export const SECTION_IDS: SectionId[] = ["words", "middle", "feelings", "world", "ledger", "can"];
export const SECTION_TITLES: Record<SectionId, string> = {
  words: "1. In their own words",
  middle: "2. What they're in the middle of",
  feelings: "3. Feelings and how they text",
  world: "4. Their world now",
  ledger: "5. What Cue has done (newest first)",
  can: "6. What Cue can do",
};
export const SECTION_BUDGETS: Record<SectionId, number> = { words: 6000, middle: 8000, feelings: 3000, world: 5000, ledger: 12000, can: 2000 };
export const HEADER_BUDGET = 500;
export const TOTAL_CAP = 40_000;
// An estimate (no tokenizer call in shadow): English text through Claude's tokenizer runs about 3.5 characters a token.
export const CHARS_PER_TOKEN = 3.5;
export const estTokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);
// The longest a ledger text's words run in the snapshot (the row keeps up to 500).
export const LEDGER_TEXT_MAX = 200;
export const STALE_AFTER_MS = 24 * 3_600_000;
// How long a reader waits for another build of the same member before building from the database itself (design §2, "~2s").
export const READ_WAIT_MS = 2_000;
// LEARN runs after the reply, so it can wait longer; if it still can't, the marks stay and the next read rebuilds.
export const LEARN_WAIT_MS = 10_000;

// One line. id: what a citation names (section letter + source id). src: the source row ("co_facts:4711", "member_claims:<uuid>").
export type Entry = { id: string; src: string; date: string | null; prov: Prov; text: string; open: boolean; kind: string };
export type Collapsed = { from: string | null; to: string | null; count: number; counts: Record<string, number>; ids: string[]; line: string; tokens: number };
export type BuiltSection = { id: SectionId; title: string; budget: number; entries: Entry[]; collapsed: Collapsed[]; tokens: number; fullTokens: number; chars: number; overBudget: boolean; sourceCount: number };
export type Compaction = { section: SectionId; count: number; idRange: [string, string] | null; tokensBefore: number; tokensAfter: number };
export type Built = {
  version: number;
  header: string;
  body: string;
  sections: BuiltSection[];
  tokens: Record<SectionId | "header" | "total", number>;
  chars: Record<SectionId | "header" | "total", number>;
  compactions: Compaction[];
  overBudget: string[];
  // entries in = rendered + collapsed, per section (the size policy's assert).
  countsMatch: boolean;
  // Lines the guards took out (forgotten), and linked names taken out of lines: counts only.
  forgotten: number;
  namesRedacted: number;
};

// What the builder reads. Everything is this member's own (user_id = them); memberKnowledge has stripped its part already.
export type ProfileRow = {
  firstName: string | null;
  city: string | null;
  lifeChapters: string[];
  direction: string | null;
  activities: string[];
  blockers: string[];
  availability: string | null;
  style: string[];
  updatedAt: Date | null;
};
export type ThreadRow = { id: string; text: string; quote: string | null; status: string; openedAt: Date; dueDate: string | null; kind: string; tone: string | null; touchedAt: Date };
export type CoGoalRow = { id: string; title: string; theirWords: string | null; status: string; at: Date; closedAt: Date | null };
export type SignalRow = { id: string; felt: string; strength: string; about: string | null; quote: string | null; source: string; at: Date };
export type ScheduledRow = { id: string; text: string; at: Date; status: string };
export type LedgerRowIn = { id: string; relation: string; said: string; url: string | null; at: Date; source: string; meta: Record<string, any> };
export type SnapshotSources = {
  userId: string;
  zone: string | null;
  team: boolean;
  profile: ProfileRow | null;
  knowledge: MemberKnowledge;
  threads: ThreadRow[];
  coGoals: CoGoalRow[];
  emotions: SignalRow[];
  scheduled: ScheduledRow[];
  ledger: LedgerRowIn[];
  forgotten: ForgottenRow[];
  // The members this one is linked with, full names where known (linkedFullNames): every word of each is fenced.
  names: string[];
  capabilities: string[];
};

// ---------------------------------------------------------------- loaders

// The assembler's sections the snapshot reads. Not exchanges (the tail), not restraint (computed against the clock), not delivered
// (the ledger section replaces it), not person (a model-built picture; its readers move onto the snapshot in step 7).
export const SNAPSHOT_KNOWLEDGE: KnowledgeSection[] = ["goals", "asks", "carrying", "lessons", "corrections", "preferences", "claims", "limits"];

type Rows = (sql: string, args: unknown[]) => Promise<any[]>;
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x: string) => x.trim()) : []);
const day = (d: unknown) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// The members this one is linked with, by full name: the same set as memberNamesStrict (services/memberSafeMemories.ts: the members
// Cue told them about or introduced them to, their own side only), with the last name read too, plus the first names Cue's own
// records give. Throws when it can't read them (the build then fails closed).
export async function linkedFullNames(userId: string, rows: Rows): Promise<string[]> {
  const M = await import("./memberSafeMemories.js");
  const full = (sql: string, from: string) => {
    if (!sql.includes(from)) throw new Error("linkedFullNames: the names query changed shape");
    return sql.replace(from, from.replace("u.first_name", "u.first_name, u.last_name"));
  };
  const [linked, network, records] = await Promise.all([
    rows(full(M.MEMBER_NAMES_SQL, "SELECT DISTINCT u.first_name FROM users u"), [userId]),
    rows(full(M.NETWORK_NAMES_SQL, "SELECT DISTINCT u.first_name FROM"), [userId]),
    rows(`SELECT content, memory_type FROM co_memories WHERE user_id = $1 AND memory_type IN ('network_intro_offer_pending', 'recommendation') ORDER BY created_at DESC LIMIT 200`, [userId]),
  ]);
  const name = (r: any) => [r.first_name, r.last_name].filter((x) => typeof x === "string" && x.trim()).join(" ");
  return [...new Set([...linked.map(name), ...network.map(name), ...M.namesInRecords(records)].filter(Boolean))];
}

export async function loadSources(userId: string, now: Date, rows: Rows = (sql, args) => pool.query(sql, args).then((r) => r.rows)): Promise<SnapshotSources> {
  const [{ memberKnowledge }, W, { isTeamMember }] = await Promise.all([
    import("./memberKnowledge.js"),
    import("./whatCoKnows.js"),
    import("./extensions.js"),
  ]);
  const [knowledge, names, forgotten, team, profile, threads, coGoals, emotions, scheduled, ledger] = await Promise.all([
    // Rejects when the linked names can't be read (memberKnowledge fails closed): the build fails, nothing is served.
    memberKnowledge(userId, { now, include: SNAPSHOT_KNOWLEDGE, corrections: { limit: 200, days: null } }),
    // The fence's own read (full names); a failure fails the build.
    linkedFullNames(userId, rows),
    // The guards' own read; a failure fails the build (a snapshot built without them could say something they had removed).
    W.forgottenRows(userId),
    isTeamMember(userId),
    rows(
      `SELECT u.first_name, cp.city, cp.life_chapters, cp.long_term_direction, cp.activity_preferences, cp.blockers, cp.availability_pattern, cp.texting_style, cp.updated_at
       FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`,
      [userId],
    ).then((r) =>
      r[0]
        ? {
            firstName: r[0].first_name ?? null,
            city: r[0].city ?? null,
            lifeChapters: strs(r[0].life_chapters),
            direction: r[0].long_term_direction ? String(r[0].long_term_direction) : null,
            activities: strs(r[0].activity_preferences),
            blockers: strs(r[0].blockers),
            availability: r[0].availability_pattern ? String(r[0].availability_pattern) : null,
            style: strs(r[0].texting_style),
            updatedAt: r[0].updated_at ? new Date(r[0].updated_at) : null,
          }
        : null,
    ),
    rows(
      `SELECT id, text, opened_quote, status, opened_at, due_date, kind, feeling AS tone, last_touched_at FROM member_threads
       WHERE user_id = $1 AND (status IN ('open', 'waiting') OR closed_at > $2::timestamptz - INTERVAL '90 days') ORDER BY last_touched_at DESC LIMIT 60`,
      [userId, now],
    ).then((r) => r.map((x) => ({ id: String(x.id), text: String(x.text ?? ""), quote: x.opened_quote ?? null, status: String(x.status), openedAt: new Date(x.opened_at), dueDate: day(x.due_date), kind: String(x.kind ?? "thread"), tone: x.tone ?? null, touchedAt: new Date(x.last_touched_at) }))),
    rows(
      `SELECT id, title, their_words, status, offered_at, closed_at FROM co_goals WHERE user_id = $1 AND (closed_at IS NULL OR closed_at > $2::timestamptz - INTERVAL '90 days') ORDER BY offered_at DESC LIMIT 20`,
      [userId, now],
    ).then((r) => r.map((x) => ({ id: String(x.id), title: String(x.title ?? ""), theirWords: x.their_words ?? null, status: String(x.status), at: new Date(x.offered_at), closedAt: x.closed_at ? new Date(x.closed_at) : null }))),
    rows(
      `SELECT id, emotion AS felt, intensity AS strength, about, quote, source, created_at FROM emotion_signals WHERE user_id = $1 AND created_at > $2::timestamptz - INTERVAL '60 days' ORDER BY created_at DESC LIMIT 40`,
      [userId, now],
    ).then((r) => r.map((x) => ({ id: String(x.id), felt: String(x.felt), strength: String(x.strength), about: x.about ?? null, quote: x.quote ?? null, source: String(x.source), at: new Date(x.created_at) }))),
    rows(`SELECT id, requested_text, scheduled_for, status FROM scheduled_calls WHERE user_id = $1 AND status IN ('pending', 'processing') ORDER BY scheduled_for LIMIT 10`, [userId]).then((r) =>
      r.map((x) => ({ id: String(x.id), text: String(x.requested_text ?? ""), at: new Date(x.scheduled_for), status: String(x.status) })),
    ),
    rows(
      `SELECT id, relation, object_label, url, happened_at, source, meta FROM co_facts
       WHERE owner_user_id = $1 AND subject = 'co' AND retired_at IS NULL AND meta ? 'ledger' ORDER BY happened_at DESC, id DESC LIMIT 4000`,
      [userId],
    ).then((r) => r.map((x) => ({ id: String(x.id), relation: String(x.relation), said: String(x.object_label ?? ""), url: x.url ?? null, at: new Date(x.happened_at), source: String(x.source ?? ""), meta: x.meta ?? {} }))),
  ]);
  return {
    userId,
    zone: knowledge.identity.zone,
    team,
    profile: profile ? { ...profile, firstName: profile.firstName ?? knowledge.identity.firstName } : null,
    knowledge,
    threads,
    coGoals,
    emotions,
    scheduled,
    ledger,
    forgotten,
    names,
    capabilities: capabilitySheet({ team }),
  };
}

// ---------------------------------------------------------------- pure: names out, guards on

// The fence's name matcher: plain and strict, independent of memberSafeMemories' person-like heuristic. Every word of every linked
// member's name (first and last) is a hit as a whole word, accents folded, in any case; a name that is also an everyday word ("May",
// "Young") only with its capital, so "in may" and "a young crowd" stay. A full name is two hits, so "Marisol Vega" can't become
// "another member Vega".
const WORD_SURNAMES = new Set("young king white brown green black gray grey long short rich hill wood stone small hall bell page wise good love fox bird bishop baker cook walker little bush lane park ford rivers banks price person case early day may".split(" "));
const foldMarks = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "");
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Pure: the name words to fence, from full names ("Marisol Vega") and first names.
export function nameTokens(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) for (const w of foldMarks(String(n ?? "")).split(/[\s,]+/)) if (/^\p{L}[\p{L}'’-]+$/u.test(w)) out.add(w);
  return [...out];
}
// Pure: whether a text names any of the tokens (strict, see above).
export function strictNameMatcher(tokens: string[]): (text: string) => boolean {
  const res = tokens.map((t) => {
    const lower = t.toLowerCase();
    const everyday = WORD_NAMES.has(lower) || WORD_SURNAMES.has(lower);
    const body = everyday ? `${esc(t[0].toUpperCase())}${[...t.slice(1)].map((c) => `[${esc(c.toLowerCase())}${esc(c.toUpperCase())}]`).join("")}` : esc(t);
    return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, everyday ? "u" : "iu");
  });
  return (text: string) => {
    if (!res.length) return false;
    const f = foldMarks(text);
    return res.some((re) => re.test(f));
  };
}

// Pure: whether a text names a linked member: the strict match above, OR the live finder (memberSafeMemories nameFinder) on the same
// name words. The strict match takes an everyday-word name only with its capital; the live finder also takes a lowercase one where
// it stands for a person ("coffee with rose", "may is moving", "max said"). Either is a hit, so the fence is never looser than the
// strip every other path uses. It over-blocks some everyday words ("in May" with a linked May): the safe side.
export function linkedNameMatcher(names: string[]): (text: string) => boolean {
  const tokens = nameTokens(names);
  const strict = strictNameMatcher(tokens);
  const live = nameFinder(tokens);
  return (text: string) => strict(text) || live(text) !== null;
}

// Pure: one line with every sentence that names a linked member made a details-free history line, the same policy as safeMemory
// (services/memberSafeMemories.ts: "Maya is building grid storage and left Tesla" is Maya's and goes; that Cue introduced them stays),
// except that the snapshot holds no other member's name at all, so the history line is nameless too. A list item ("; ") is one
// sentence. A lead-in label without a name ("Thread (open): ") is kept.
export function fenceLine(text: string, hits: (t: string) => boolean): { text: string; n: number } {
  if (!hits(text)) return { text, n: 0 };
  let n = 0;
  const lead = text.match(/^([^:\n]{1,60}:\s)/)?.[1] ?? "";
  const keepLead = lead && !hits(lead) ? lead : "";
  const rest = text.slice(keepLead.length);
  const seen = new Set<string>();
  const one = (piece: string) => {
    if (!hits(piece)) return piece;
    n++;
    const h = namelessHistoryLine(piece);
    if (seen.has(h)) return "";
    seen.add(h);
    return h;
  };
  const out = rest
    .split(/(?<=[.!?])\s+/)
    // A history line memberKnowledge's strip already wrote ("Marisol, another member, came up here; ...") is one sentence, whole.
    .map((sentence) => (sentence.includes("; ") && hits(sentence) && !/\banother member\b/i.test(sentence) ? sentence.split("; ").map(one).filter(Boolean).join("; ") : one(sentence)))
    .filter(Boolean)
    .join(" ");
  return { text: `${keepLead}${out}`.trim(), n };
}

const DATE = (d: Date | string | null | undefined, zone: string | null): string | null => {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
  return DateTime.fromJSDate(t).setZone(wordsZone(zone)).toISODate();
};
// A uuid by its first 8 hex digits (the stored sections keep the full source id); any other id as letters and digits only.
const short = (s: string) => (/^[0-9a-f-]{36}$/i.test(s) ? s.replace(/-/g, "").slice(0, 8) : s.replace(/[^A-Za-z0-9]+/g, "").slice(0, 24) || hash8(s));
const hash8 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 8);
const one = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const q = (s: string) => `"${clip(one(s), 240)}"`;

// ---------------------------------------------------------------- pure: the entries

type Raw = Omit<Entry, "text"> & { text: string; guard: Guarded | "none" | "words" };

function entriesOf(s: SnapshotSources): Record<SectionId, Raw[]> {
  const z = s.zone;
  const k = s.knowledge;
  const p = s.profile;
  const out: Record<SectionId, Raw[]> = { words: [], middle: [], feelings: [], world: [], ledger: [], can: [] };
  const add = (sec: SectionId, e: Raw) => {
    if (one(e.text)) out[sec].push({ ...e, text: one(e.text) });
  };
  const pDate = DATE(p?.updatedAt, z);

  // 1. In their own words
  if (p?.city) add("words", { id: "Pcity", src: "co_profiles:city", date: pDate, prov: "said", text: `Lives in: ${p.city}`, open: false, kind: "profile", guard: "words" });
  if (p?.direction) add("words", { id: "Pdirection", src: "co_profiles:long_term_direction", date: pDate, prov: "said", text: `Where they're headed: ${p.direction}`, open: false, kind: "profile", guard: "words" });
  p?.lifeChapters.forEach((c, i) => add("words", { id: `Pchapter${i + 1}`, src: `co_profiles:life_chapters:${i}`, date: pDate, prov: "said", text: `Life chapter: ${c}`, open: false, kind: "profile", guard: "words" }));
  p?.activities.forEach((a, i) => add("words", { id: `Plikes${i + 1}`, src: `co_profiles:activity_preferences:${i}`, date: pDate, prov: "said", text: `Likes doing: ${a}`, open: false, kind: "profile", guard: "words" }));
  if (k.limits?.availability) add("words", { id: "Pfree", src: "co_profiles:availability", date: DATE(k.limits.verifiedAt, z), prov: "said", text: `Usually free: ${k.limits.availability}`, open: false, kind: "limit", guard: "words" });
  k.limits?.avoid.forEach((a) => add("words", { id: `V${hash8(a)}`, src: "co_profiles:avoid", date: DATE(k.limits!.verifiedAt, z), prov: "said", text: `Not for them: ${a}`, open: false, kind: "limit", guard: "words" }));
  k.corrections.forEach((c) =>
    add("words", { id: `C${hash8(`${c.field}|${c.was}|${c.now}`)}`, src: "profile_corrections", date: DATE(c.verifiedAt, z), prov: "said", text: `Corrected ${c.field}: was ${q(c.was)}, now ${c.now == null ? "(removed)" : q(c.now)}`, open: false, kind: "correction", guard: "none" }),
  );
  k.claims.forEach((c) =>
    add("words", {
      id: `K${hash8(`${c.kind}|${c.text}|${c.saidOn}`)}`,
      src: "member_claims",
      date: c.saidOn || DATE(c.verifiedAt, z),
      prov: c.provenance === "user_said" ? "said" : "inferred",
      text: `${c.kind}: ${c.text}${c.quote ? ` (their words: ${q(c.quote)})` : ""}${c.expiresOn ? ` [until ${c.expiresOn}]` : ""}`,
      open: false,
      kind: "claim",
      guard: "claim",
    }),
  );
  k.preferences.forEach((x) => add("words", { id: `F${hash8(x.text)}`, src: x.source === "stated" ? "co_memories:taste" : "suggestion_outcomes", date: DATE(x.verifiedAt, z), prov: x.source === "stated" ? "said" : "seen", text: x.source === "stated" ? `Told Cue: ${x.text}` : `How finds landed: ${x.text}`, open: false, kind: "preference", guard: "words" }));

  // 2. What they're in the middle of
  for (const t of s.threads) {
    const open = t.status === "open" || t.status === "waiting";
    add("middle", {
      id: `H${short(t.id)}`,
      src: `member_threads:${t.id}`,
      date: DATE(open ? t.openedAt : t.touchedAt, z),
      prov: "said",
      text: `${t.kind === "commitment" ? "Commitment" : "Thread"} (${t.status}${t.dueDate ? `, by ${t.dueDate}` : ""}${t.tone ? `, feeling ${t.tone}` : ""}): ${t.text}${t.quote ? ` (their words: ${q(t.quote)})` : ""}`,
      open,
      kind: "thread",
      guard: "thread",
    });
  }
  for (const g of k.goals) add("middle", { id: `G${g.hash.slice(0, 8)}`, src: `goal_states:${g.hash}`, date: DATE(g.verifiedAt, z), prov: g.source === "context" ? "inferred" : "said", text: `Goal (${g.state}${g.onFile ? "" : ", no longer on file"}): ${g.text}${g.reason ? ` [${g.reason}]` : ""}`, open: g.state === "active", kind: "goal", guard: "words" });
  for (const g of s.coGoals) {
    const open = !g.closedAt && g.status !== "closed" && g.status !== "declined";
    add("middle", { id: `Y${g.id}`, src: `co_goals:${g.id}`, date: DATE(g.closedAt ?? g.at, z), prov: "said", text: `Goal plan (${g.status}): ${g.title}${g.theirWords ? ` (their words: ${q(g.theirWords)})` : ""}`, open, kind: "goal_plan", guard: "words" });
  }
  for (const a of k.asks) add("middle", { id: `A${short(a.id)}`, src: `ask_checkins:${a.id}`, date: DATE(a.verifiedAt, z), prov: "said", text: `Open ask (${a.kind}): ${a.text}`, open: true, kind: "ask", guard: "words" });
  for (const c of k.carrying.filter((c) => c.kind === "loop"))
    add("middle", { id: `O${(c.ref ?? hash8(c.what)).replace(/\D+/g, "") || hash8(c.what)}`, src: c.ref ? `open_loops:${c.ref.replace(/\D+/g, "")}` : "open_loops", date: DATE(c.verifiedAt, z), prov: "said", text: `Open loop (${c.status ?? "open"}${c.dueAt ? `, by ${DATE(c.dueAt, z)}` : ""}): ${c.what}${c.detail ? ` [${c.detail}]` : ""}`, open: c.state !== "done", kind: "loop", guard: "words" });
  p?.blockers.forEach((b, i) => add("middle", { id: `Pblock${i + 1}`, src: `co_profiles:blockers:${i}`, date: pDate, prov: "said", text: `In the way: ${b}`, open: false, kind: "profile", guard: "words" }));

  // 3. Feelings and how they text
  for (const e of s.emotions)
    add("feelings", { id: `E${e.id}`, src: `emotion_signals:${e.id}`, date: DATE(e.at, z), prov: "inferred", text: `Felt ${e.felt} (${e.strength}${e.about ? `, about ${e.about}` : ""}, read from a ${e.source})${e.quote ? `: ${q(e.quote)}` : ""}`, open: false, kind: "feeling", guard: "words" });
  for (const l of k.lessons) add("feelings", { id: `N${hash8(l.text)}`, src: "co_memories:co_lesson", date: DATE(l.verifiedAt, z), prov: "inferred", text: `Lesson from their pushback: ${l.text}`, open: false, kind: "lesson", guard: "words" });
  p?.style.forEach((x, i) => add("feelings", { id: `S${i + 1}`, src: `co_profiles:texting_style:${i}`, date: pDate, prov: "inferred", text: `How they text: ${x}`, open: false, kind: "style", guard: "words" }));

  // 4. Their world now (dates only: whether a thing is due is read against the clock, in the tail)
  for (const c of k.carrying.filter((c) => c.kind !== "loop")) {
    const ref = c.ref ? c.ref.replace(/\s*#\s*/, "").replace(/\s+/g, "") : `promise${hash8(c.what)}`;
    const open = c.state !== "done";
    add("world", {
      id: `W${ref}`,
      src: c.ref ? `${c.kind === "document" ? "document_deliveries" : "co_tasks"}:${c.ref.replace(/\D+/g, "")}` : "co_memories:promise_result",
      date: DATE(c.verifiedAt, z),
      prov: "did",
      text: `${c.kind === "brief" ? "Research brief" : c.kind === "document" ? "Document" : c.kind === "promise" ? "Promise" : c.kind === "lookout" ? "Look-out" : "Task"} (${open ? "open" : "done"}${c.theyHaveIt ? ", they have it" : ""}${c.dueAt ? `, by ${DATE(c.dueAt, z)}` : ""}): ${c.what}${c.detail ? ` [${c.detail}]` : ""}`,
      open,
      kind: c.kind,
      guard: "words",
    });
  }
  for (const c of s.scheduled) add("world", { id: `Q${short(c.id)}`, src: `scheduled_calls:${c.id}`, date: DATE(c.at, z), prov: "did", text: `Call scheduled (${c.status}) for ${DateTime.fromJSDate(c.at).setZone(wordsZone(z)).toFormat("yyyy-LL-dd h:mma")}: ${c.text}`, open: true, kind: "scheduled", guard: "words" });

  // 5. What Cue has done
  for (const r of s.ledger) {
    const m = r.meta ?? {};
    const notes = [m.receipt && m.receipt !== "done" ? `receipt ${m.receipt}` : null, m.offer_state ? `offer ${m.offer_state}` : null, m.outcome ? `outcome ${m.outcome}` : null, m.reaction ? `reaction ${m.reaction}` : null, m.version ? `v${m.version}` : null].filter(Boolean);
    const words = r.relation === "texted" ? q(clip(r.said, LEDGER_TEXT_MAX)) : clip(one(r.said), LEDGER_TEXT_MAX);
    add("ledger", {
      id: `L${r.id}`,
      src: `co_facts:${r.id}`,
      date: DATE(r.at, z),
      prov: "did",
      text: `${r.relation}${m.kind && m.kind !== "text" ? ` ${m.kind}` : ""}: ${words}${r.url ? ` <${r.url}>` : ""}${notes.length ? ` (${notes.join(", ")})` : ""}`,
      // A promise is open until kept (no promised rows yet: the ledger's promise kind comes with the cutover).
      open: r.relation === "promised" && !m.kept,
      kind: r.relation,
      guard: "words",
    });
  }

  // 6. What Cue can do
  s.capabilities.forEach((c, i) => add("can", { id: `X${i + 1}`, src: "capabilities", date: null, prov: "seen", text: c, open: false, kind: "capability", guard: "none" }));
  return out;
}

// ---------------------------------------------------------------- pure: size policy

export const lineOf = (e: Pick<Entry, "id" | "prov" | "date" | "text">) => `- [${e.id} ${e.prov}${e.date ? ` ${e.date}` : ""}] ${e.text}`;
const sectionText = (title: string, lines: string[]) => [`## ${title}`, ...lines].join("\n");

// Pure: entries past the budget, oldest first, collapsed into one line per month (counts by kind, the source ids kept).
function collapse(entries: Entry[]): Collapsed[] {
  const byMonth = new Map<string, Entry[]>();
  for (const e of entries) {
    const m = e.date ? e.date.slice(0, 7) : "undated";
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(e);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, es]) => {
      const dates = es.map((e) => e.date).filter((d): d is string => !!d).sort();
      const counts: Record<string, number> = {};
      for (const e of es) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
      const from = dates[0] ?? null, to = dates[dates.length - 1] ?? null;
      const ids = es.map((e) => e.id);
      const span = from ? (from === to ? from : `${from}–${to}`) : "undated";
      const line = `- [Earlier ${span}] ${Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([kind, n]) => `${n} ${kind}`).join(", ")} [${ids[ids.length - 1]}…${ids[0]}, ${ids.length} entries]`;
      return { from, to, count: es.length, counts, ids: es.map((e) => e.src), line, tokens: estTokens(line) };
    });
}

// Pure: one section within its budget. Open entries always stay; closed ones are kept newest first while they fit, and the rest are
// collapsed. Section 6 (what Cue can do) is a list Cue reads whole and is never collapsed: past its budget it overflows and says so.
// Deterministic: the same entries give the same section. Sizes are counted in characters (a line and its newline), so finding the
// cut is arithmetic, not a re-render per try.
export function fitSection(id: SectionId, entries: Entry[], budget = SECTION_BUDGETS[id]): BuiltSection {
  const title = SECTION_TITLES[id];
  const byNewest = (a: Entry, b: Entry) => (b.date ?? "").localeCompare(a.date ?? "") || b.id.localeCompare(a.id);
  const whole = id === "can";
  const open = whole ? entries : entries.filter((e) => e.open).sort(byNewest);
  const closed = whole ? [] : entries.filter((e) => !e.open).sort(byNewest);
  const head = `## ${title}`.length;
  const openChars = open.reduce((n, e) => n + lineOf(e).length + 1, 0);
  const prefix = [0];
  for (const e of closed) prefix.push(prefix[prefix.length - 1] + lineOf(e).length + 1);
  const charsAt = (keep: number) => head + openChars + prefix[keep] + collapse(closed.slice(keep)).reduce((n, c) => n + c.line.length + 1, 0);
  const fits = (keep: number) => Math.ceil(charsAt(keep) / CHARS_PER_TOKEN) <= budget;
  let keep = closed.length;
  if (!fits(keep)) {
    // The largest number kept that fits (binary search), then one at a time while the next still fits: collapsing one more entry
    // into a month that already has a line can make a longer keep fit again.
    let lo = 0, hi = closed.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    keep = lo;
    while (keep < closed.length && fits(keep + 1)) keep++;
  }
  const kept = [...open, ...closed.slice(0, keep)];
  const col = collapse(closed.slice(keep));
  const text = sectionText(title, [...kept.map(lineOf), ...col.map((c) => c.line)]);
  const tokens = estTokens(text);
  const fullTokens = estTokens(sectionText(title, [...open, ...closed].map(lineOf)));
  return { id, title, budget, entries: kept, collapsed: col, tokens, fullTokens, chars: text.length, overBudget: tokens > budget, sourceCount: entries.length };
}

// ---------------------------------------------------------------- pure: the build

// Pure: the snapshot from its sources. Names out of every line, the guards on every line, each section fitted to its budget.
export function buildSnapshot(s: SnapshotSources, o: { version: number }): Built {
  const raw = entriesOf(s);
  let forgotten = 0, namesRedacted = 0;
  const hits = linkedNameMatcher(s.names);
  const sections = SECTION_IDS.map((id) => {
    const entries: Entry[] = [];
    for (const r of raw[id]) {
      let text: string | null = r.text;
      if (s.forgotten.length && r.guard !== "none") {
        if (r.guard !== "words" && forgets(text, s.forgotten, r.guard)) text = null;
        else text = guardText(text, s.forgotten);
      }
      if (text === null || !text.trim()) {
        forgotten++;
        continue;
      }
      const red = fenceLine(text, hits);
      namesRedacted += red.n;
      const { guard: _g, ...e } = r;
      entries.push({ ...e, text: red.text });
    }
    return fitSection(id, entries);
  });
  const firstName = s.profile?.firstName ?? s.knowledge.identity.firstName ?? null;
  const header = `# Cue's snapshot of ${firstName ?? "this member"} · v${o.version} · zone ${s.zone ?? "unknown"}`;
  const body = [header, ...sections.map((x) => sectionText(x.title, [...x.entries.map(lineOf), ...x.collapsed.map((c) => c.line)]))].join("\n\n");
  const tokens = Object.fromEntries([...sections.map((x) => [x.id, x.tokens]), ["header", estTokens(header)], ["total", estTokens(body)]]) as Built["tokens"];
  const chars = Object.fromEntries([...sections.map((x) => [x.id, x.chars]), ["header", header.length], ["total", body.length]]) as Built["chars"];
  const compactions: Compaction[] = sections
    .filter((x) => x.collapsed.length)
    .map((x) => {
      const ids = x.collapsed.flatMap((c) => c.ids);
      return { section: x.id, count: x.collapsed.reduce((n, c) => n + c.count, 0), idRange: ids.length ? [ids[ids.length - 1], ids[0]] : null, tokensBefore: x.fullTokens, tokensAfter: x.tokens };
    });
  const overBudget = [...sections.filter((x) => x.overBudget).map((x) => x.id), ...(tokens.total > TOTAL_CAP ? ["total"] : []), ...(tokens.header > HEADER_BUDGET ? ["header"] : [])];
  const countsMatch = sections.every((x) => x.sourceCount === x.entries.length + x.collapsed.reduce((n, c) => n + c.count, 0));
  return { version: o.version, header, body, sections, tokens, chars, compactions, overBudget, countsMatch, forgotten, namesRedacted };
}

// ---------------------------------------------------------------- the fence

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
export type FenceResult = { ok: true } | { ok: false; kind: "name" | "user_id"; hits: number };

// Pure: the body's linked-name hits, every word of every linked name, strictly (the header's own first name aside: it's theirs, even when a linked member shares it) and the
// user ids written in it other than their own.
export function fenceScan(b: Pick<Built, "header" | "body">, names: string[], userId: string): { nameHits: number; ids: string[] } {
  const hits = linkedNameMatcher(names);
  const rest = b.body.slice(b.header.length);
  let nameHits = 0;
  for (const line of rest.split("\n")) if (hits(line)) nameHits++;
  const ids = [...new Set((b.body.match(UUID) ?? []).map((x) => x.toLowerCase()))].filter((x) => x !== userId.toLowerCase());
  return { nameHits, ids };
}

// The assert: no linked name, and no other member's user id, anywhere in the body. lookup says which of the ids are users.
export async function fenceCheck(b: Pick<Built, "header" | "body">, names: string[], userId: string, lookup: (ids: string[]) => Promise<string[]>): Promise<FenceResult> {
  const scan = fenceScan(b, names, userId);
  if (scan.nameHits) return { ok: false, kind: "name", hits: scan.nameHits };
  if (scan.ids.length) {
    const users = await lookup(scan.ids);
    if (users.length) return { ok: false, kind: "user_id", hits: users.length };
  }
  return { ok: true };
}
const usersAmong = (rows: Rows) => async (ids: string[]) => (await rows(`SELECT id::text FROM users WHERE id = ANY($1::uuid[])`, [ids])).map((r) => String(r.id));

// ---------------------------------------------------------------- build, store, read

export type SnapshotDeps = { load: (userId: string, now: Date) => Promise<SnapshotSources>; rows: Rows; log: (d: Parameters<typeof recordDecision>[0]) => Promise<void> };
const realDeps = (): SnapshotDeps => ({ load: (u, now) => loadSources(u, now), rows: (sql, args) => pool.query(sql, args).then((r) => r.rows), log: (d) => recordDecision(d).catch(() => {}) });

export type MemoryBuild = { built: Built | null; fence: FenceResult | null; ms: number; error: string | null };
// A build in memory: reads only, writes nothing, logs nothing (the shadow measure, and a reader that couldn't get the lock).
export async function buildInMemory(userId: string, o: { now?: Date; version?: number; deps?: Partial<SnapshotDeps> } = {}): Promise<MemoryBuild> {
  const d = { ...realDeps(), ...o.deps };
  const started = Date.now();
  try {
    const src = await d.load(userId, o.now ?? new Date());
    const built = buildSnapshot(src, { version: o.version ?? 0 });
    const fence = await fenceCheck(built, src.names, userId, usersAmong(d.rows));
    return { built, fence, ms: Date.now() - started, error: null };
  } catch (err: any) {
    return { built: null, fence: null, ms: Date.now() - started, error: err?.constructor?.name ?? "Error" };
  }
}

export type StoredSnapshot = { userId: string; version: number; builtAt: Date; body: string; sections: any[]; tokens: Record<string, number>; blocked: string | null; dirtyAt: Date | null };
export type ReadState = "fresh" | "rebuilt" | "built_unstored" | "blocked" | "failed";
export type SnapshotRead = { snapshot: StoredSnapshot | null; state: ReadState; waitedMs: number; buildMs: number | null };

type Db = { connect: () => Promise<PoolClient>; query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };
// The store transaction holds one connection while the build's reads run on the shared pool. On the shared pool, enough builds at once
// (LEARN for several members) would each hold a connection and wait on the others for their reads; so store transactions get their own
// small pool, and a build that can't get one within 5s fails (its marks stay; the next read rebuilds). Made on first use.
let storePool: Pool | null = null;
const defaultDb = (): Db => (storePool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 5_000 })) as unknown as Db;
// The two-key advisory lock space (key 1 = "SNAP"), apart from the one-key locks the phone lock uses (db/advisoryLock.ts).
const LOCK_NS = 0x534e4150;
const lockKey = (userId: string) => createHash("md5").update(userId).digest().readInt32BE(0);

const STATE_SQL = `SELECT s.user_id, s.version, s.built_at, s.body, s.sections, s.tokens, s.blocked,
  (SELECT min(d.dirty_at) FROM member_snapshot_dirty d WHERE d.user_id = $1) AS dirty_at,
  EXISTS (SELECT 1 FROM member_snapshot_dirty d WHERE d.user_id = $1) AS dirty
  FROM member_snapshots s WHERE s.user_id = $1`;
const toStored = (r: any): StoredSnapshot => ({ userId: String(r.user_id), version: Number(r.version), builtAt: new Date(r.built_at), body: String(r.body ?? ""), sections: r.sections ?? [], tokens: r.tokens ?? {}, blocked: r.blocked ?? null, dirtyAt: r.dirty_at ? new Date(r.dirty_at) : null });
// Pure: whether a stored row can be served as it is.
export function isFresh(r: { dirty: boolean; built_at: Date | string } | null | undefined, now: Date): boolean {
  return !!r && !r.dirty && now.getTime() - new Date(r.built_at).getTime() < STALE_AFTER_MS;
}

// A member whose builds keep failing doesn't take every upkeep slot: each failure doubles the wait before the upkeep tries them again
// (15 minutes, 30, 1h... at most 24h), and it's logged with the count. A stored build resets it. Only a member with a stored row has
// one (the upkeep only rebuilds those). Never throws.
export const BACKOFF_BASE_MIN = 15;
async function noteFailure(db: Db, d: SnapshotDeps, userId: string, state: string): Promise<void> {
  try {
    const r = (
      await db.query(
        `UPDATE member_snapshots SET fail_count = fail_count + 1, last_failed_at = NOW(),
           next_attempt_at = NOW() + LEAST(make_interval(mins => ${BACKOFF_BASE_MIN}) * power(2, LEAST(fail_count, 10)), INTERVAL '24 hours')
         WHERE user_id = $1 RETURNING fail_count, next_attempt_at`,
        [userId],
      )
    ).rows[0];
    await d.log({ layer: 4, decision: "snapshot.build_failed", userId, outcome: "skip", action: state, proposal: { failCount: r ? Number(r.fail_count) : null, nextAttemptAt: r?.next_attempt_at ?? null } });
  } catch {}
}

export type StoreResult = { state: "stored" | "blocked" | "fresh" | "locked" | "failed" | "mismatch"; snapshot: StoredSnapshot | null; waitedMs: number; buildMs: number | null; consumed: number };

// Build and store under the member's lock, in one transaction: the marks the build saw are deleted with the store, so a write that
// commits while it reads leaves its mark and the next read rebuilds; a failed build rolls back and leaves every mark where it was.
//   force: build even when fresh (LEARN). Otherwise a build that waited re-reads first: the build it waited for may have just stored.
export async function storeBuild(userId: string, o: { reason: string; force?: boolean; waitMs?: number; now?: () => Date; db?: Db; deps?: Partial<SnapshotDeps> }): Promise<StoreResult> {
  const db: Db = o.db ?? defaultDb();
  const d = { ...realDeps(), ...o.deps };
  const nowOf = o.now ?? (() => new Date());
  const waitMs = o.waitMs ?? READ_WAIT_MS;
  const client = await db.connect();
  let waitedMs = 0;
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    const t0 = Date.now();
    let got = false;
    for (;;) {
      got = (await client.query(`SELECT pg_try_advisory_xact_lock($1, $2) AS ok`, [LOCK_NS, lockKey(userId)])).rows[0]?.ok === true;
      waitedMs = Date.now() - t0;
      if (got || waitedMs >= waitMs) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!got) {
      await client.query("ROLLBACK");
      open = false;
      return { state: "locked", snapshot: null, waitedMs, buildMs: null, consumed: 0 };
    }
    const prev = (await client.query(STATE_SQL, [userId])).rows[0] ?? null;
    if (!o.force && isFresh(prev, nowOf())) {
      await client.query("COMMIT");
      open = false;
      return { state: prev.blocked ? "blocked" : "fresh", snapshot: prev.blocked ? null : toStored(prev), waitedMs, buildMs: null, consumed: 0 };
    }
    // The marks committed by now: their writes are visible to every read below.
    const consumed = (await client.query(`DELETE FROM member_snapshot_dirty WHERE user_id = $1 RETURNING id`, [userId])).rows.length;
    const builtAt = (await client.query(`SELECT clock_timestamp() AS at`)).rows[0].at;
    const version = (prev ? Number(prev.version) : 0) + 1;
    const started = Date.now();
    const src = await d.load(userId, nowOf());
    const built = buildSnapshot(src, { version });
    const fence = await fenceCheck(built, src.names, userId, usersAmong(d.rows));
    const buildMs = Date.now() - started;
    if (!built.countsMatch) {
      // Nothing is dropped silently: the previous version stays, the marks stay, and it's logged (counts only).
      await client.query("ROLLBACK");
      open = false;
      await d.log({ layer: 4, decision: "snapshot.count_mismatch", userId, outcome: "skip", action: "kept_previous", proposal: { version, sections: built.sections.map((x) => ({ id: x.id, in: x.sourceCount, kept: x.entries.length, collapsed: x.collapsed.reduce((n, c) => n + c.count, 0) })) } });
      await noteFailure(db, d, userId, "mismatch");
      return { state: "mismatch", snapshot: null, waitedMs, buildMs, consumed: 0 };
    }
    const blocked = fence.ok ? null : fence.kind;
    const sections = blocked ? [] : built.sections.map((x) => ({ id: x.id, tokens: x.tokens, budget: x.budget, overBudget: x.overBudget, entries: x.entries.map(({ text: _t, ...e }) => e), collapsed: x.collapsed.map(({ line: _l, ...c }) => c) }));
    const row = (
      await client.query(
        `INSERT INTO member_snapshots (user_id, version, built_at, build_ms, sections, body, tokens, chars, compactions, over_budget, blocked, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (user_id) DO UPDATE SET version = EXCLUDED.version, built_at = EXCLUDED.built_at, build_ms = EXCLUDED.build_ms, sections = EXCLUDED.sections,
           body = EXCLUDED.body, tokens = EXCLUDED.tokens, chars = EXCLUDED.chars, compactions = EXCLUDED.compactions, over_budget = EXCLUDED.over_budget,
           blocked = EXCLUDED.blocked, fail_count = 0, next_attempt_at = NULL, updated_at = NOW()
         RETURNING user_id, version, built_at, body, sections, tokens, blocked`,
        [userId, version, builtAt, buildMs, JSON.stringify(sections), blocked ? "" : built.body, JSON.stringify(blocked ? {} : built.tokens), JSON.stringify(blocked ? {} : built.chars), JSON.stringify(blocked ? [] : built.compactions), blocked ? [] : built.overBudget, blocked],
      )
    ).rows[0];
    await client.query("COMMIT");
    open = false;
    // Counts only, never a line of it.
    const tokens = built.tokens;
    await d.log({ layer: 4, decision: "snapshot.build", userId, outcome: blocked ? "skip" : "act", action: blocked ? "fence_block" : "stored", proposal: { reason: o.reason, version, ms: buildMs, waitedMs, consumed, tokens: blocked ? null : tokens, entries: built.sections.reduce((n, x) => n + x.entries.length, 0), forgotten: built.forgotten, namesRedacted: built.namesRedacted } });
    if (blocked) await d.log({ layer: 4, decision: "snapshot.fence_block", userId, outcome: "skip", action: "no_snapshot", reason: `${fence.ok ? 0 : fence.hits} ${blocked} hit(s)`, proposal: { kind: blocked, hits: fence.ok ? 0 : fence.hits, version } });
    else {
      if (built.compactions.length) await d.log({ layer: 4, decision: "snapshot.compacted", userId, outcome: "act", action: "collapsed", proposal: { version, sections: built.compactions } });
      if (built.overBudget.length) await d.log({ layer: 4, decision: "snapshot.over_budget", userId, outcome: "act", action: "overflowed", proposal: { version, over: built.overBudget, tokens } });
    }
    return { state: blocked ? "blocked" : "stored", snapshot: blocked ? null : toStored({ ...row, dirty_at: null }), waitedMs, buildMs, consumed };
  } catch (err: any) {
    if (open) await client.query("ROLLBACK").catch(() => {});
    console.error("memberSnapshot: build failed (non-fatal; the marks stay):", err?.constructor?.name ?? "Error");
    await noteFailure(db, d, userId, "failed");
    return { state: "failed", snapshot: null, waitedMs, buildMs: null, consumed: 0 };
  } finally {
    client.release();
  }
}

// THE read (no lane calls it yet: shadow). The stored snapshot when nothing changed since it was built and it's under 24h old;
// otherwise a rebuild first, under the member's lock. A text that arrives while another build of theirs is running waits up to
// READ_WAIT_MS for it, then builds from the database itself without storing. A blocked fence or a failed build returns no snapshot:
// the caller runs on the tail and rules, never on an older version.
export async function readSnapshot(userId: string, o: { now?: () => Date; waitMs?: number; db?: Db; deps?: Partial<SnapshotDeps> } = {}): Promise<SnapshotRead> {
  const db: Db = o.db ?? defaultDb();
  const nowOf = o.now ?? (() => new Date());
  try {
    const cur = (await db.query(STATE_SQL, [userId])).rows[0] ?? null;
    if (isFresh(cur, nowOf())) return { snapshot: cur.blocked ? null : toStored(cur), state: cur.blocked ? "blocked" : "fresh", waitedMs: 0, buildMs: null };
  } catch {
    return { snapshot: null, state: "failed", waitedMs: 0, buildMs: null };
  }
  const r = await storeBuild(userId, { reason: "read", waitMs: o.waitMs ?? READ_WAIT_MS, now: nowOf, db, deps: o.deps });
  if (r.state === "stored") return { snapshot: r.snapshot, state: "rebuilt", waitedMs: r.waitedMs, buildMs: r.buildMs };
  if (r.state === "fresh") return { snapshot: r.snapshot, state: "fresh", waitedMs: r.waitedMs, buildMs: null };
  if (r.state === "blocked") return { snapshot: null, state: "blocked", waitedMs: r.waitedMs, buildMs: r.buildMs };
  if (r.state !== "locked") return { snapshot: null, state: "failed", waitedMs: r.waitedMs, buildMs: r.buildMs };
  // Still locked after the wait: build from the database itself, unstored.
  const m = await buildInMemory(userId, { now: nowOf(), deps: { ...o.deps, rows: o.deps?.rows ?? ((sql, args) => db.query(sql, args).then((x) => x.rows)) } });
  if (!m.built || !m.fence) return { snapshot: null, state: "failed", waitedMs: r.waitedMs, buildMs: m.ms };
  if (!m.fence.ok) return { snapshot: null, state: "blocked", waitedMs: r.waitedMs, buildMs: m.ms };
  return { snapshot: { userId, version: 0, builtAt: nowOf(), body: m.built.body, sections: [], tokens: m.built.tokens, blocked: null, dirtyAt: null }, state: "built_unstored", waitedMs: r.waitedMs, buildMs: m.ms };
}

// LEARN: after a turn's learning writes land, version N+1. Never throws; a lock it can't get leaves the marks for the next read.
export async function rebuildSnapshot(userId: string, reason = "learn", o: { db?: Db; deps?: Partial<SnapshotDeps>; waitMs?: number } = {}): Promise<StoreResult["state"]> {
  try {
    return (await storeBuild(userId, { reason, force: true, waitMs: o.waitMs ?? LEARN_WAIT_MS, db: o.db, deps: o.deps })).state;
  } catch {
    return "failed";
  }
}

// The upkeep pass (jobs/index.ts): every stored snapshot that is stale (a write since it was built) or older than 24h is rebuilt, a
// bounded batch at a time, so a removal leaves the stored copy within a pass even while nothing reads it. A member without a stored
// snapshot isn't built here (LEARN makes the first one). A member backing off after failed builds waits for their next attempt,
// unless they removed or corrected something since.
// Marks: those of members with no stored snapshot are dropped after an hour (absence already means "build first", and deleted accounts
// go this way); every mark is dropped after MARK_MAX_HOURS whoever it's for. That can't hide a change: a mark that old means the
// stored snapshot (built before it, or the mark would be gone) is already past 24h, which rebuilds it on its own.
export const MARK_MAX_HOURS = 48;
export async function snapshotUpkeep(o: { limit?: number; db?: Db; deps?: Partial<SnapshotDeps> } = {}): Promise<{ rebuilt: number; skipped: number; pruned: number; retried: number }> {
  const db: Db = o.db ?? defaultDb();
  // A removal or correction since a member's last failed build (a profile_corrections mark) ends their wait: this pass tries them
  // again, so something they had Cue forget doesn't sit in the stored copy until the backoff runs out. The count keeps growing, so a
  // build that still fails waits longer next time.
  const retried = (
    await db.query(
      `UPDATE member_snapshots s SET next_attempt_at = NULL
       WHERE s.next_attempt_at > NOW() AND EXISTS (
         SELECT 1 FROM member_snapshot_dirty d WHERE d.user_id = s.user_id AND d.source = 'profile_corrections' AND d.dirty_at > COALESCE(s.last_failed_at, '-infinity'))
       RETURNING s.user_id`,
    )
  ).rows.length;
  const due = (
    await db.query(
      `SELECT s.user_id FROM member_snapshots s
       WHERE (EXISTS (SELECT 1 FROM member_snapshot_dirty d WHERE d.user_id = s.user_id) OR s.built_at < NOW() - INTERVAL '24 hours')
         AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= NOW())
       ORDER BY s.built_at LIMIT $1`,
      [o.limit ?? 20],
    )
  ).rows.map((r) => String(r.user_id));
  let rebuilt = 0, skipped = 0;
  for (const u of due) {
    const r = await storeBuild(u, { reason: "upkeep", waitMs: 0, db, deps: o.deps });
    if (r.state === "stored" || r.state === "blocked") rebuilt++;
    else skipped++;
  }
  const pruned = (
    await db.query(
      `DELETE FROM member_snapshot_dirty d
       WHERE d.dirty_at < NOW() - make_interval(hours => ${MARK_MAX_HOURS})
          OR (d.dirty_at < NOW() - INTERVAL '1 hour' AND NOT EXISTS (SELECT 1 FROM member_snapshots s WHERE s.user_id = d.user_id))
       RETURNING d.id`,
    )
  ).rows.length;
  return { rebuilt, skipped, pruned, retried };
}
