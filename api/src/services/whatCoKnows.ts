// What Co knows about a member, shown to them and correctable by them (Royce, 2026-10-12: "Member knowledge, visible and
// correctable. A member can ask what Co knows about them, get it in plain language, and correct or remove anything. Corrections
// apply immediately, everywhere that knowledge is read.").
//
// ---------------------------------------------------------------- where member knowledge lives
//
//   co_profiles        city, long_term_direction, availability_pattern (single values); goals, life_chapters, blockers,
//                      activity_preferences (lists); avoid (kinds they asked Co to stop suggesting); intent (asks and goal entries).
//                      Written by the turn and call learning (services/profileExtraction.ts storeProfile), steerAwayFrom, saveAsk.
//   member_claims      what they told Co, labelled user_said / co_inferred, with a lifetime (services/claims.ts). Rebuilt nightly
//                      from their words since the last refresh.
//   person_snapshots   who they are now: work, place, wants now, weighing on them, what matters in people (harness/personSnapshot.ts).
//                      Rebuilt from the last 21 days of their words, at most every 10 minutes while they talk.
//   member_threads     what's going on in their life (harness/memberThreads.ts), rebuilt with the snapshot.
//   member_kit         company, role, LinkedIn, from their own words (services/memberKit.ts saveKitFact).
//   co_memories        room_taste (services/roomTaste.ts) and design_taste (services/designTaste.ts, decks and pages); also the raw
//                      conversation (text_exchange, call_transcript, recap) and Co's own notes (co_lesson: team-internal, never shown).
//   ask_checkins       their open asks (with the intent entries they mirror).
//   their files        PDFs they sent, by number, read only through services/memberFiles.ts (contents never enter the conversation).
//   co_facts           Co's action record (what Co did, not what it knows about them) and the people graph (wants/offers for
//                      in-room matching, derived from the snapshot and goals by services/peopleGraph.ts).
//   profile_corrections  the dated corrections record: field, what Co had, what's true now (null: removed), their words.
//
// ---------------------------------------------------------------- who reads it
//
//   replies     services/turnContext.ts assembleContext (co_profiles row, snapshot, threads, kit, member knowledge) and
//               harness/replyGrounding.ts gatherReplyFacts / addMemberKnowledge (corrections, taste, claims, snapshot).
//   calls       services/callContext.ts (member knowledge incl. corrections, person model), harness/callGrounding.ts.
//   sweeps      services/sweepFind.ts, services/sweepSelectContext.ts, services/goalSweep.ts (member knowledge: goals, person model,
//               preferences, limits, corrections), services/goalEdges.ts (goal corrections retire goals).
//   tasks       services/taskTurn.ts, services/followUps.ts, harness/proactive.ts, jobs/postCallFollowUp.ts (member knowledge).
//   decks/pages services/designTaste.ts loadDesignTaste, room taste through member knowledge preferences.
//   matching    co_profiles.goal_embeddings (services/relevance.ts) and the people graph (co_facts wants/offers).
//
// Every one of those reads its source fresh on each turn, call, sweep or task: nothing caches member knowledge between them. So a
// correction is "everywhere, immediately" when it changes the source row itself, which is what this file does.
//
// ---------------------------------------------------------------- how a correction reaches every reader
//
//   1. whatCoKnows reads every source above for one member (user_id = $1 on every statement), strips other members' details
//      (memberSafeLine, fails closed) and leaves out what's team-internal (Co's lessons, restraint, feelings Co read, Co's action
//      record). Items that say the same thing in the same group are one line with all their refs, so one correction hits all copies.
//   2. applyKnowledgeChanges changes the SOURCE: the profile field or list item, the claim row, the snapshot field, the thread, the
//      kit row, the taste memory, the ask, the avoid entry or the file. A removal deletes or closes it, so no reader can read it
//      again; it is never a note on top of the old value.
//   3. Each change is written to profile_corrections (the existing corrections mechanism) with item_ref and removed. A correction
//      is read by every reader of member knowledge as "only the corrected version exists", and the profile extraction already
//      refuses to put a corrected value back (profileExtraction.ts recentlyCorrected, now without the 90-day window for these rows).
//      A removal is NOT read back as "was X": memberKnowledge leaves removed rows out, so what they removed is never put in front of
//      Co again. Readers get only a count (removedCount), and a reply gets a content-free rule to leave out anything the older
//      messages say that they asked to forget.
//   4. The things that rebuild themselves from older words are guarded with the same rows (forgottenRows / forgets): the snapshot
//      rebuild, the nightly claims refresh, the thread rebuild and the profile extraction drop anything corrected away or removed.
//      A specific removal also takes out the raw lines that say it from memberKnowledge's exchanges (calls, tasks, follow-ups,
//      dispatch) and from the reply's memory search.
//   5. Derived copies are refreshed: goal embeddings recomputed when goals change, a reworded ask's embedding redone, the people
//      graph's wants/offers that say the old thing retired at once and re-read in the background, and the day's picks re-ranked
//      (rerunPickerForTaste).
//   6. Every change goes to the decision log (harness_decisions: knowledge.correct / knowledge.remove / knowledge.change_refused),
//      besides the tool guard's own tool.correctWhatCoKnows receipt.
//
// What it doesn't reach yet: the reply's own recent thread (the last 20 texts, raw, as the conversation itself), the call context's
// "what they told you in the last two days" and recent texts when the old words don't match a removal closely, Co's lessons and
// research notes (team-internal, never shown), Pinterest boards behind deck taste, and a call already in progress (it keeps the
// context it started with; the next call reads the change).
import { createHash } from "node:crypto";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";

// ---------------------------------------------------------------- types

export type KnownSource = "profile" | "goal" | "claim" | "snapshot" | "thread" | "kit" | "taste" | "ask" | "avoid" | "file";
export type KnownGroup = "where" | "work" | "after" | "said" | "mind" | "likes" | "files";
export const GROUP_TITLES: Record<KnownGroup, string> = {
  where: "Where you are",
  work: "Your work",
  after: "What you're after",
  said: "What you've told me",
  mind: "What's on your mind",
  likes: "What you like and don't",
  files: "Files you sent",
};
const GROUP_ORDER: KnownGroup[] = ["where", "work", "after", "mind", "likes", "said", "files"];

// One thing Co holds, from one source row. ref is stable across turns (an id, a field, or a hash of the text).
export type KnownItem = { ref: string; source: KnownSource; group: KnownGroup; text: string; theirWords: string | null; canCorrect: boolean };
// What the member is shown: items in a group that say the same thing, as one line with all their refs.
export type KnownLine = { refs: string[]; text: string; theirWords: string | null; canCorrect: boolean };
export type KnownView = { groups: { group: KnownGroup; title: string; lines: KnownLine[] }[] };

export type Change = { refs: string[]; action: "correct" | "remove"; now?: string | null };
export type Applied = { ref: string; source: KnownSource; was: string; now: string | null };
export type ChangeResult = { ok: boolean; applied: Applied[]; refused: { ref: string; why: string }[]; alsoSays: KnownLine[] };

// ---------------------------------------------------------------- pure helpers

export const hashOf = (s: string) => createHash("sha1").update(s.trim().toLowerCase()).digest("hex").slice(0, 8);
const squash = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set("the and for but not you are was has had with that this what your have just like would want into some more they them their from about also then than over will i'm im my me a an of to in on at is it be so do".split(" "));
const words = (s: string) => squash(s).split(" ").filter((w) => w.length >= 3 && !STOP.has(w));

// Same words, same thing (services/profileExtraction.ts nearDuplicate, kept local and pure so this file has no model imports).
export function sameThing(a: string, b: string): boolean {
  const A = new Set(words(a).map(stem)), B = new Set(words(b).map(stem));
  if (!A.size || !B.size) return squash(a) === squash(b);
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size) >= 0.75;
}
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "");

const CHAPTER_WORDS: Record<string, string> = { new_to_city: "new to the city", building_solo: "building something on your own", career_pivot: "changing careers", starting_over: "starting over" };

export type RawKnown = {
  profile: { city: string | null; long_term_direction: string | null; availability_pattern: string | null; goals: string[]; life_chapters: string[]; blockers: string[]; activity_preferences: string[]; avoid: string[]; intent: any[] } | null;
  claims: { id: string; text: string; provenance: string; kind: string; quote: string | null; live: boolean }[];
  snapshot: { work: string | null; place: string | null; wantsNow: string[]; weighingOn: string[]; valuesInPeople: string[] } | null;
  threads: { id: string; text: string; quote: string | null }[];
  kit: { key: string; value: string }[];
  tastes: { id: string; type: "room_taste" | "design_taste"; text: string; quote: string | null }[];
  asks: { id: string; text: string }[];
  files: { n: number; sentOn: string }[];
};

const CLAIM_GROUP: Record<string, KnownGroup> = { city: "where", identity: "said", building: "work", role: "work", relationship: "said", preference: "likes", plan: "after", deadline: "after", meeting: "after", exploring: "after", pending_decision: "mind", worry: "mind", mood: "mind", away: "where" };

// Pure: every item from the raw reads. The member's own name, phone and email (account details) aren't listed: they're the account,
// not something Co learned. Co's lessons, restraint, feelings and the action record never are (team-internal).
export function knownItems(r: RawKnown): KnownItem[] {
  const out: KnownItem[] = [];
  const add = (ref: string, source: KnownSource, group: KnownGroup, text: string | null | undefined, theirWords: string | null = null, canCorrect = true) => {
    const t = String(text ?? "").trim();
    if (t) out.push({ ref, source, group, text: t.slice(0, 240), theirWords: theirWords?.trim() ? theirWords.trim().slice(0, 200) : null, canCorrect });
  };
  const p = r.profile;
  if (p) {
    add("profile:city", "profile", "where", p.city);
    add("profile:availability_pattern", "profile", "where", p.availability_pattern);
    add("profile:long_term_direction", "profile", "after", p.long_term_direction);
    for (const g of p.goals) add(`profile:goals:${hashOf(g)}`, "profile", "after", g);
    for (const c of p.life_chapters) add(`profile:life_chapters:${hashOf(c)}`, "profile", "where", CHAPTER_WORDS[c] ?? c.replace(/_/g, " "), null, false);
    for (const b of p.blockers) add(`profile:blockers:${hashOf(b)}`, "profile", "mind", b);
    for (const a of p.activity_preferences) add(`profile:activity_preferences:${hashOf(a)}`, "profile", "likes", a);
    for (const a of p.avoid) add(`avoid:${hashOf(a)}`, "avoid", "likes", `not for you: ${a}`, null, false);
    for (const e of p.intent) if (e?.kind === "goal" && e?.status === "active" && typeof e?.text === "string" && e?.id) add(`goal:${e.id}`, "goal", "after", e.text);
  }
  for (const c of r.claims) if (c.live) add(`claim:${c.id}`, "claim", CLAIM_GROUP[c.kind] ?? "said", c.provenance === "co_inferred" ? `my read: ${c.text}` : c.text, c.provenance === "user_said" ? c.quote : null);
  const s = r.snapshot;
  if (s) {
    add("snapshot:place", "snapshot", "where", s.place);
    add("snapshot:work", "snapshot", "work", s.work);
    for (const w of s.wantsNow) add(`snapshot:wantsNow:${hashOf(w)}`, "snapshot", "after", w);
    for (const w of s.weighingOn) add(`snapshot:weighingOn:${hashOf(w)}`, "snapshot", "mind", w);
    for (const w of s.valuesInPeople) add(`snapshot:valuesInPeople:${hashOf(w)}`, "snapshot", "likes", w);
  }
  for (const t of r.threads) add(`thread:${t.id}`, "thread", "mind", t.text, t.quote);
  for (const k of r.kit) add(`kit:${k.key}`, "kit", "work", `${k.key === "linkedin" ? "LinkedIn" : k.key}: ${k.value}`);
  for (const t of r.tastes) add(`taste:${t.id}`, "taste", "likes", t.text, t.quote, false);
  for (const a of r.asks) add(`ask:${a.id}`, "ask", "after", `looking out for: ${a.text}`);
  for (const f of r.files) add(`file:${f.n}`, "file", "files", `file ${f.n}, sent ${f.sentOn}`, null, false);
  return out;
}

// Pure: grouped, the same thing said in more than one place shown once with all its refs, short.
export function groupKnown(items: KnownItem[], perGroup = 8): KnownView {
  const groups: KnownView["groups"] = [];
  for (const g of GROUP_ORDER) {
    const lines: KnownLine[] = [];
    for (const i of items.filter((x) => x.group === g)) {
      const plain = i.text.replace(/^(my read|looking out for|not for you): /, "");
      const same = g !== "files" ? lines.find((l) => sameThing(l.text.replace(/^(my read|looking out for|not for you): /, ""), plain)) : undefined;
      if (same) {
        same.refs.push(i.ref);
        same.theirWords ??= i.theirWords;
        same.canCorrect &&= i.canCorrect;
        // Their own words lead: a line they said beats Co's read of it.
        if (same.text.startsWith("my read: ") && !i.text.startsWith("my read: ")) same.text = i.text;
      } else lines.push({ refs: [i.ref], text: i.text, theirWords: i.theirWords, canCorrect: i.canCorrect });
    }
    if (lines.length) groups.push({ group: g, title: GROUP_TITLES[g], lines: lines.slice(0, perGroup) });
  }
  return { groups };
}

// Pure: the view as one fact line for the reply's grounding (refs left out: they're for the tool, never for a text).
export function knownFact(v: KnownView): string {
  if (!v.groups.length) return "What Co knows about them: nothing yet beyond their name and number.";
  return `What Co knows about them, the complete list (answer only from this; never add to it): ${v.groups.map((g) => `${g.title}: ${g.lines.map((l) => (l.theirWords ? `${l.text} (their words: "${l.theirWords}")` : l.text)).join("; ")}`).join(". ")}.`;
}

// Pure: a corrected value has to rest on their words: at least one of its real words is in what they said this turn.
export function backedBy(now: string, message: string): boolean {
  const said = new Set(words(message).map(stem));
  const w = words(now).map(stem);
  return w.length === 0 ? false : w.some((x) => said.has(x));
}

// Pure: other lines that still say what was just changed (a city in a claim the member didn't name), so Co can offer to fix them too.
export function stillSaying(view: KnownView, applied: Applied[], changedRefs: Set<string>): KnownLine[] {
  const olds = applied.map((a) => plainOf(a.was)).filter(Boolean);
  const out: KnownLine[] = [];
  for (const g of view.groups)
    for (const l of g.lines) {
      if (l.refs.some((r) => changedRefs.has(r))) continue;
      const hit = olds.some((o) => sameThing(o, l.text) || (words(o).length <= 3 && words(o).length > 0 && new RegExp(`\\b${words(o).map((w) => w.replace(/[^a-z0-9']/g, "")).join("\\W+")}\\b`, "i").test(l.text)));
      if (hit) out.push(l);
    }
  return out.slice(0, 6);
}

// ---------------------------------------------------------------- forgetting (the guards for what rebuilds itself)

// A correction or removal made through this file: what Co had, what's true now (null: removed), and which source it came from.
export type ForgottenRow = { field: string; old: string; now: string | null; ref: string; removed: boolean };

export async function forgottenRows(userId: string, q: { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> } = pool): Promise<ForgottenRow[]> {
  const { rows } = await q.query(`SELECT field, old_value, new_value, item_ref, removed FROM profile_corrections WHERE user_id = $1 AND item_ref IS NOT NULL ORDER BY corrected_at DESC LIMIT 200`, [userId]);
  return rows.map((r: any) => ({ field: String(r.field), old: String(r.old_value ?? ""), now: r.new_value == null ? null : String(r.new_value), ref: String(r.item_ref), removed: !!r.removed }));
}

// Which rows guard which rebuilt thing: a row guards its own kind of source (a claim row guards claims; where they live guards the
// snapshot's place). A removal whose old text is specific (two or more real words) guards every source, so a removed thing can't
// come back by another door. A one-word value ("Berkeley") only guards its own kind, so a corrected city never takes "studied at
// UC Berkeley" with it.
export type Guarded = "claim" | "thread" | "snapshot:place" | "snapshot:work" | "snapshot:list" | "profile_field" | "their_words";
const GUARDED_BY: Record<Guarded, string[]> = {
  claim: ["claim:"],
  thread: ["thread:"],
  "snapshot:place": ["snapshot:place", "profile:city"],
  "snapshot:work": ["snapshot:work", "kit:"],
  "snapshot:list": ["snapshot:wantsNow", "snapshot:weighingOn", "snapshot:valuesInPeople"],
  // The profile's own fields are guarded by field in profileExtraction.ts; here only specific removals from elsewhere.
  profile_field: [],
  // The raw exchanges and memories that say a removed thing (memberKnowledge exchanges, the reply's memory search): only specific removals.
  their_words: [],
};
const plainOf = (t: string) => t.replace(/^(my read|looking out for|not for you): /, "");

// Pure: the row that says this text is gone (or changed), if any.
export function forgets(text: string, rows: ForgottenRow[], what: Guarded): ForgottenRow | null {
  for (const r of rows) {
    const own = GUARDED_BY[what].some((p) => r.ref.startsWith(p));
    const specific = r.removed && words(r.old).length >= 2;
    if (!own && !specific) continue;
    if (!sameThing(plainOf(r.old), text)) continue;
    if (r.now && sameThing(r.now, text)) continue;
    return r;
  }
  return null;
}

// Pure: a rebuilt snapshot with what they corrected away or removed taken out. A one-value field that still says the old value
// takes the new one when its own kind was corrected (where they live), and is emptied when it was removed.
export function forgetInSnapshot<T extends { work: string | null; place: string | null; wantsNow: string[]; weighingOn: string[]; valuesInPeople: string[] }>(s: T, rows: ForgottenRow[]): T {
  if (!rows.length) return s;
  const one = (v: string | null, what: Guarded) => {
    if (!v) return v;
    const r = forgets(v, rows, what);
    if (!r) return v;
    return r.now && GUARDED_BY[what].some((p) => r.ref.startsWith(p)) ? r.now.replace(/^[a-z]+: /, "") : null;
  };
  const list = (xs: string[]) => (Array.isArray(xs) ? xs.filter((x) => !forgets(x, rows, "snapshot:list")) : xs);
  return { ...s, work: one(s.work, "snapshot:work"), place: one(s.place, "snapshot:place"), wantsNow: list(s.wantsNow), weighingOn: list(s.weighingOn), valuesInPeople: list(s.valuesInPeople) };
}

// ---------------------------------------------------------------- reading

export async function readKnown(userId: string): Promise<RawKnown> {
  const q = (sql: string, args: unknown[]) => pool.query(sql, args).then((r) => r.rows as any[]);
  const [prof, claims, snap, threads, kit, tastes, asks, files, zone] = await Promise.all([
    q(`SELECT city, long_term_direction, availability_pattern, goals, life_chapters, blockers, activity_preferences, avoid, intent FROM co_profiles WHERE user_id = $1`, [userId]),
    q(`SELECT id, text, provenance, kind, quote, expires_on FROM member_claims WHERE user_id = $1 ORDER BY said_on DESC LIMIT 40`, [userId]),
    q(`SELECT snapshot FROM person_snapshots WHERE user_id = $1`, [userId]),
    q(`SELECT id, text, opened_quote FROM member_threads WHERE user_id = $1 AND status IN ('open', 'waiting') ORDER BY last_touched_at DESC NULLS LAST LIMIT 8`, [userId]),
    q(`SELECT key, value FROM member_kit WHERE user_id = $1 AND key IN ('company', 'role', 'linkedin')`, [userId]),
    // The tastes their readers read: room taste's last 5 inside 180 days (roomTaste.ts loadRoomTaste), design taste's newest.
    Promise.all([
      q(`SELECT id, memory_type, content FROM co_memories WHERE user_id = $1 AND memory_type = 'room_taste' AND created_at > NOW() - INTERVAL '180 days' ORDER BY created_at DESC LIMIT 5`, [userId]),
      q(`SELECT id, memory_type, content FROM co_memories WHERE user_id = $1 AND memory_type = 'design_taste' ORDER BY created_at DESC LIMIT 1`, [userId]),
    ]).then(([a, b]) => [...a, ...b]),
    q(`SELECT ask_id, ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL ORDER BY last_mentioned_at DESC NULLS LAST, created_at DESC LIMIT 12`, [userId]),
    import("./memberFiles.js").then((m) => m.filesOnFile(userId)).catch(() => [] as { n: number; sentOn: string }[]),
    import("./memberTime.js").then((m) => m.memberZone(userId)).catch(() => null),
  ]);
  const F = await import("./factLabels.js");
  const { wordsZone } = await import("./memberTime.js");
  const R = await import("./roomTaste.js");
  const D = await import("./designTaste.js");
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);
  const p = prof[0];
  const s = snap[0]?.snapshot ?? null;
  const day = (d: unknown) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  return {
    profile: p ? { city: p.city ?? null, long_term_direction: p.long_term_direction ?? null, availability_pattern: p.availability_pattern ?? null, goals: arr(p.goals), life_chapters: arr(p.life_chapters), blockers: arr(p.blockers), activity_preferences: arr(p.activity_preferences), avoid: arr(p.avoid), intent: Array.isArray(p.intent) ? p.intent : [] } : null,
    claims: claims.map((c) => ({ id: String(c.id), text: String(c.text), provenance: String(c.provenance), kind: String(c.kind), quote: c.quote ?? null, live: F.isLive({ expiresOn: day(c.expires_on) }, new Date(), wordsZone(zone)) })),
    snapshot: s ? { work: s.work ?? null, place: s.place ?? null, wantsNow: arr(s.wantsNow), weighingOn: arr(s.weighingOn), valuesInPeople: arr(s.valuesInPeople) } : null,
    threads: threads.map((t) => ({ id: String(t.id), text: String(t.text), quote: t.opened_quote ?? null })),
    kit: kit.map((k) => ({ key: String(k.key), value: String(k.value) })),
    tastes: tastes.flatMap((t): RawKnown["tastes"] => {
      if (t.memory_type === "room_taste") {
        const x = R.parseRoomTaste(String(t.content ?? ""));
        return x ? [{ id: String(t.id), type: "room_taste" as const, text: R.roomTasteLine(x), quote: x.quote ?? null }] : [];
      }
      const x = D.parseDesignTaste(String(t.content ?? ""));
      return x ? [{ id: String(t.id), type: "design_taste" as const, text: D.designTasteLine(x).replace(/ \(their words: .*\)$/, ""), quote: x.quote || null }] : [];
    }),
    asks: asks.map((a) => ({ id: String(a.ask_id), text: String(a.ask_text ?? "") })).filter((a) => a.text.trim()),
    files,
  };
}

// What the member is shown: every item, stripped of other members' details. Throws when the names to strip can't be read (fails
// closed, PR #118): nothing unstripped is ever shown.
export async function whatCoKnows(userId: string): Promise<{ view: KnownView; items: KnownItem[] }> {
  const { memberSafeLine } = await import("./memberSafeMemories.js");
  const safe = await memberSafeLine(userId);
  const items = knownItems(await readKnown(userId)).flatMap((i) => {
    const text = safe(i.text);
    if (!text?.trim()) return [];
    // Their own words are theirs (safeMemory keeps "User said:" the same way), but a name in them is still stripped.
    const theirWords = i.theirWords ? safe(i.theirWords) : null;
    return [{ ...i, text: text.trim(), theirWords: theirWords?.trim() || null }];
  });
  return { view: groupKnown(items), items };
}

// ---------------------------------------------------------------- changing

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

// Applies one item's change at its source. Returns what it had and what it holds now, or why it can't.
async function applyOne(db: Db, userId: string, raw: RawKnown, item: KnownItem, action: "correct" | "remove", now: string | null, theirWords: string): Promise<Applied | { why: string }> {
  const [kind, a, b] = item.ref.split(":");
  const was = item.text;
  if (action === "correct" && !item.canCorrect) return { why: "this kind can only be removed; remove it and note the new one with its own tool" };
  const v = action === "correct" ? now : null;
  switch (kind) {
    case "profile": {
      const field = a;
      if (["city", "long_term_direction", "availability_pattern"].includes(field)) {
        await db.query(`UPDATE co_profiles SET ${field} = $2, updated_at = NOW() WHERE user_id = $1`, [userId, v]);
        return { ref: item.ref, source: "profile", was: String((raw.profile as any)?.[field] ?? was), now: v };
      }
      if (!["goals", "life_chapters", "blockers", "activity_preferences"].includes(field)) return { why: "not a field that can change" };
      const list: string[] = ((raw.profile as any)?.[field] ?? []) as string[];
      const old = list.find((x) => hashOf(x) === b);
      if (!old) return { why: "it's no longer on file" };
      const next = list.filter((x) => x !== old);
      if (v && !next.includes(v)) next.unshift(v);
      await db.query(`UPDATE co_profiles SET ${field} = $2, updated_at = NOW() WHERE user_id = $1`, [userId, next]);
      return { ref: item.ref, source: "profile", was: old, now: v };
    }
    case "goal": {
      // Out of the intent list entirely on a removal (a "removed" status would still read as a set-aside goal in memberKnowledge).
      const intent = raw.profile?.intent ?? [];
      const e = intent.find((x: any) => x?.id === a);
      if (!e) return { why: "it's no longer on file" };
      const next = v ? intent.map((x: any) => (x?.id === a ? { ...x, text: v, confirmed_at: new Date().toISOString() } : x)) : intent.filter((x: any) => x?.id !== a);
      await db.query(`UPDATE co_profiles SET intent = $2::jsonb, updated_at = NOW() WHERE user_id = $1`, [userId, JSON.stringify(next)]);
      const { goalHash } = await import("./goalEdges.js");
      await db.query(`DELETE FROM goal_states WHERE user_id = $1 AND goal_hash = $2`, [userId, goalHash(String(e.text))]).catch(() => {});
      return { ref: item.ref, source: "goal", was: String(e.text), now: v };
    }
    case "claim": {
      if (v) await db.query(`UPDATE member_claims SET text = $3, provenance = 'user_said', quote = $4, confirmed_on = CURRENT_DATE WHERE id = $1 AND user_id = $2`, [a, userId, v, theirWords.slice(0, 200)]);
      else await db.query(`DELETE FROM member_claims WHERE id = $1 AND user_id = $2`, [a, userId]);
      return { ref: item.ref, source: "claim", was: raw.claims.find((c) => c.id === a)?.text ?? was, now: v };
    }
    case "snapshot": {
      const { rows } = await db.query(`SELECT snapshot FROM person_snapshots WHERE user_id = $1`, [userId]);
      const s = rows[0]?.snapshot;
      if (!s) return { why: "it's no longer on file" };
      let old: string | null = null;
      if (a === "work" || a === "place") {
        old = s[a] ?? null;
        s[a] = v;
      } else if (["wantsNow", "weighingOn", "valuesInPeople"].includes(a)) {
        const list: string[] = Array.isArray(s[a]) ? s[a] : [];
        old = list.find((x) => hashOf(x) === b) ?? null;
        s[a] = list.filter((x) => x !== old);
        if (v && old) s[a].unshift(v);
      }
      if (!old) return { why: "it's no longer on file" };
      // updated_at is left alone: the next rebuild still runs on schedule, and its guard (forgetInSnapshot) keeps this change.
      await db.query(`UPDATE person_snapshots SET snapshot = $2 WHERE user_id = $1`, [userId, JSON.stringify(s)]);
      return { ref: item.ref, source: "snapshot", was: old, now: v };
    }
    case "thread": {
      if (v) await db.query(`UPDATE member_threads SET text = $3, last_touched_at = NOW() WHERE id = $1 AND user_id = $2`, [a, userId, v]);
      else {
        await db.query(`UPDATE member_threads SET status = 'changed', closed_quote = $3, closed_at = NOW() WHERE id = $1 AND user_id = $2`, [a, userId, theirWords.slice(0, 300)]);
        // Nothing left to follow up on (the same as a thread closing, memberThreads.ts applyThreadProposal).
        await db.query(`UPDATE proactive_candidates SET status = 'skipped', updated_at = NOW() WHERE user_id = $1 AND target_key = $2 AND status = 'pending'`, [userId, `thread:${a}`]).catch(() => {});
      }
      return { ref: item.ref, source: "thread", was: raw.threads.find((t) => t.id === a)?.text ?? was, now: v };
    }
    case "kit": {
      const old = raw.kit.find((k) => k.key === a)?.value ?? was;
      if (v) await db.query(`UPDATE member_kit SET value = $3, updated_at = NOW() WHERE user_id = $1 AND key = $2`, [userId, a, v]);
      else await db.query(`DELETE FROM member_kit WHERE user_id = $1 AND key = $2`, [userId, a]);
      return { ref: item.ref, source: "kit", was: `${a}: ${old}`, now: v ? `${a}: ${v}` : null };
    }
    case "taste": {
      const t = raw.tastes.find((x) => x.id === a);
      if (!t) return { why: "it's no longer on file" };
      // Design taste is one thing (its reader takes the newest), so all of it goes: an older one must not come back in its place.
      if (t.type === "design_taste") await db.query(`DELETE FROM co_memories WHERE user_id = $1 AND memory_type = 'design_taste'`, [userId]);
      else await db.query(`DELETE FROM co_memories WHERE id = $1 AND user_id = $2 AND memory_type = 'room_taste'`, [a, userId]);
      return { ref: item.ref, source: "taste", was: t.text, now: null };
    }
    case "ask": {
      const old = raw.asks.find((x) => x.id === a)?.text ?? was;
      if (v) {
        // Reworded in both places it lives (the check-in row and its intent entry); the entry's embedding is redone in the background
        // (refreshDerived), and until then the old one is dropped so matching never reads the old words.
        await db.query(`UPDATE ask_checkins SET ask_text = $3 WHERE user_id = $1 AND ask_id = $2`, [userId, a, v]);
        const intent = (raw.profile?.intent ?? []).map((x: any) => (x?.id === a ? { ...x, text: v, embedding: null } : x));
        await db.query(`UPDATE co_profiles SET intent = $2::jsonb, updated_at = NOW() WHERE user_id = $1`, [userId, JSON.stringify(intent)]);
      } else {
        const { closeAsk } = await import("./askKind.js");
        await closeAsk(userId, a, "member", theirWords.slice(0, 300));
      }
      return { ref: item.ref, source: "ask", was: old, now: v };
    }
    case "avoid": {
      const list = raw.profile?.avoid ?? [];
      const old = list.find((x) => hashOf(x) === a);
      if (!old) return { why: "it's no longer on file" };
      await db.query(`UPDATE co_profiles SET avoid = $2 WHERE user_id = $1`, [userId, list.filter((x) => x !== old)]);
      return { ref: item.ref, source: "avoid", was: old, now: null };
    }
    case "file": {
      const { deleteFiles } = await import("./memberFiles.js");
      const n = Number(a);
      if (!Number.isFinite(n) || !(await deleteFiles(userId, n))) return { why: "that file isn't on file" };
      return { ref: item.ref, source: "file", was: `file ${n}`, now: null };
    }
  }
  return { why: "not something Co can change" };
}

// The corrections record's field for a ref: the co_profiles field itself for profile refs (so the extraction's own guard,
// profileExtraction.ts recentlyCorrected, matches it), else a plain name every reader can print.
export function fieldFor(ref: string): string {
  const [kind, a] = ref.split(":");
  if (kind === "profile") return a;
  if (kind === "goal") return "goals";
  if (kind === "snapshot") return a === "place" ? "where they are" : a === "work" ? "their work" : a === "wantsNow" ? "what they want now" : a === "weighingOn" ? "what's weighing on them" : "what matters to them in people";
  if (kind === "kit") return `their ${a === "linkedin" ? "LinkedIn" : a}`;
  return { claim: "what they told Co", thread: "what's going on for them", taste: "their taste", ask: "what Co looks out for", avoid: "what they don't want suggested" }[kind] ?? kind;
}

// Changes items at their source, records each in the corrections record and the decision log, and refreshes what's derived.
// theirWords: their own words asking for it, from this message (checked by the tool guard's their_yes).
export async function applyKnowledgeChanges(userId: string, changes: Change[], o: { message: string; theirWords: string }): Promise<ChangeResult> {
  const raw = await readKnown(userId);
  const items = knownItems(raw);
  const byRef = new Map(items.map((i) => [i.ref, i]));
  const applied: Applied[] = [];
  const refused: ChangeResult["refused"] = [];
  const changedRefs = new Set<string>();
  for (const c of changes) {
    const now = c.action === "correct" ? String(c.now ?? "").trim().slice(0, 200) : null;
    if (c.action === "correct" && !now) {
      for (const ref of c.refs) refused.push({ ref, why: "a correction needs what's true now" });
      continue;
    }
    // What's true now rests on their words: never a value Co made up.
    if (now && !backedBy(now, o.message)) {
      for (const ref of c.refs) refused.push({ ref, why: "what's true now has to come from their own words in this message" });
      continue;
    }
    // A ref Co gave as the line's words instead of its ref is matched to the items that say exactly that, in one group.
    const resolved = [...new Set(c.refs)].flatMap((ref) => {
      if (byRef.has(ref)) return [ref];
      const hits = items.filter((i) => squash(plainOf(i.text)) === squash(plainOf(ref)) || sameThing(plainOf(i.text), plainOf(ref)));
      return hits.length && hits.length <= 4 && new Set(hits.map((h) => h.group)).size === 1 ? hits.map((h) => h.ref) : [ref];
    });
    for (const ref of [...new Set(resolved)]) {
      const item = byRef.get(ref);
      if (!item) {
        refused.push({ ref, why: "not one of the items on file now (call whatCoKnows again for the current list)" });
        continue;
      }
      const r = await applyOne(pool, userId, raw, item, c.action, now, o.theirWords);
      if ("why" in r) {
        refused.push({ ref, why: r.why });
        continue;
      }
      applied.push(r);
      changedRefs.add(ref);
      // The corrections record every reader already carries; a file's removal is recorded only in the decision log (its name and
      // contents are never written anywhere else, memberFiles.ts rule 3).
      if (r.source !== "file")
        await pool.query(`INSERT INTO profile_corrections (user_id, field, old_value, new_value, quote, item_ref, removed) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [userId, fieldFor(ref), r.was, r.now, o.theirWords.slice(0, 300), ref, r.now == null]);
      await recordDecision({
        layer: 3,
        decision: r.now == null ? "knowledge.remove" : "knowledge.correct",
        userId,
        outcome: "act",
        action: r.source,
        proposal: { ref, was: r.source === "file" ? r.was : r.was.slice(0, 240), now: r.now, theirWords: o.theirWords.slice(0, 300) },
        checks: [{ name: "their_words_in_message", pass: true }, ...(now ? [{ name: "new_value_backed", pass: true }] : [])],
      }).catch(() => {});
    }
  }
  if (refused.length) {
    await recordDecision({ layer: 3, decision: "knowledge.change_refused", userId, outcome: "skip", action: "refused", proposal: { refused, theirWords: o.theirWords.slice(0, 300) }, checks: refused.map((r) => ({ name: "change_allowed", pass: false, reason: `${r.ref}: ${r.why}` })) }).catch(() => {});
  }
  if (applied.length) void refreshDerived(userId, applied).catch((err: any) => console.error("whatCoKnows: refreshing derived copies failed (non-fatal):", err?.message ?? err));
  // What else still says it, from the fresh read (stripped like the view).
  const after = await whatCoKnows(userId).catch(() => null);
  return { ok: applied.length > 0, applied, refused, alsoSays: after ? stillSaying(after.view, applied, changedRefs) : [] };
}

// Derived copies: goal embeddings, the people graph, the day's picks. In the background: the reply never waits on it.
async function refreshDerived(userId: string, applied: Applied[]): Promise<void> {
  if (applied.some((a) => a.ref.startsWith("profile:goals:") || a.source === "goal")) {
    const { rows } = await pool.query(`SELECT goals FROM co_profiles WHERE user_id = $1`, [userId]);
    const goals: string[] = Array.isArray(rows[0]?.goals) ? rows[0].goals : [];
    const { generateGoalEmbedding } = await import("./embeddings.js");
    const emb = goals.length ? await generateGoalEmbedding(goals).catch(() => null) : null;
    await pool.query(`UPDATE co_profiles SET goal_embeddings = $2 WHERE user_id = $1`, [userId, emb ? `[${emb.join(",")}]` : null]).catch((err: any) => console.error("whatCoKnows: goal embedding update failed (non-fatal):", err?.message ?? err));
  }
  // A reworded ask gets its embedding back, from its new words.
  for (const a of applied.filter((x) => x.source === "ask" && x.now)) {
    const id = a.ref.slice("ask:".length);
    const { generateEmbedding } = await import("./embeddings.js");
    const emb = await generateEmbedding(a.now!).catch(() => null);
    if (!emb) continue;
    const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]);
    const intent = Array.isArray(rows[0]?.intent) ? rows[0].intent.map((x: any) => (x?.id === id && x?.text === a.now ? { ...x, embedding: emb } : x)) : null;
    if (intent) await pool.query(`UPDATE co_profiles SET intent = $2::jsonb WHERE user_id = $1`, [userId, JSON.stringify(intent)]);
  }
  // The people graph's wants/offers that say the old thing are retired now; the rest are re-read from the corrected sources.
  const { rows: facts } = await pool.query(`SELECT id, object_label FROM co_facts WHERE owner_user_id = $1 AND relation IN ('wants', 'offers') AND retired_at IS NULL`, [userId]);
  const stale = facts.filter((f: any) => applied.some((a) => sameThing(a.was.replace(/^(my read|looking out for|not for you): /, ""), String(f.object_label)))).map((f: any) => f.id);
  if (stale.length) await pool.query(`UPDATE co_facts SET retired_at = NOW() WHERE owner_user_id = $1 AND id = ANY($2::bigint[])`, [userId, stale]);
  if (stale.length) await (await import("./peopleGraph.js")).refreshPeopleFacts(userId, { maxAgeHours: 0 }).catch(() => null);
  void import("./sweepShadow.js").then((m) => m.rerunPickerForTaste(userId)).catch(() => {});
}
