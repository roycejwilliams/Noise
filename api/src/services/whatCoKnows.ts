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
//   member_design_signals  their design system (services/designSystem.ts): every look signal, folded per context on read. Shown
//                      as the look and the fonts of their decks and pages per context, and each confirmed reference read.
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
//   7. The raw words read through the same guards (guardText / guardRows / guardBlock): the reply's last 20 texts, memberKnowledge's
//      exchanges (calls' "last two days" and recent texts, tasks, follow-ups, dispatch, the sweep), the reply's memory search, the
//      call's recap. A line saying something removed is dropped; a line still saying a corrected-away value keeps its words with
//      "[since corrected: ...]" inline; their ask to forget keeps only that it was asked.
//   8. A live call: every turn of an ElevenLabs call comes through Co's own call brain endpoint (routes/callLlm.ts) with the whole
//      prompt, so the call's instructions are read through the guards each turn (guardCallMessages, re-read every 20 seconds and
//      right after a tool acts). A change made by text during the call, or by a tool on it, reaches its next turn.
//   9. What's queued on what changed (cancelQueued, on the change's transaction): proactive candidates, open tasks and look-outs,
//      network backlogs and deferred sends tied to the ask, goal or thread, or whose own words say it. A removal cancels; a
//      correction sends it back to be re-checked. Each one is logged (knowledge.cancel_queued).
//
// What it still doesn't reach: the words already spoken on a live call (the call's own transcript so far is the conversation, as
// it happens; ElevenLabs sends it each turn and Co doesn't rewrite what was said), and Co's lessons and research notes
// (team-internal, never shown).
import { createHash } from "node:crypto";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { safetySignal } from "./safetyText.js";
import * as designPure from "./designSystem.js";

// ---------------------------------------------------------------- types

export type KnownSource = "profile" | "goal" | "claim" | "snapshot" | "thread" | "kit" | "taste" | "inspo" | "design" | "designfont" | "designref" | "ask" | "avoid" | "file";
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
export type ChangeResult = { ok: boolean; applied: Applied[]; refused: { ref: string; why: string }[]; alsoSays: KnownLine[]; cancelled?: Cancelled[] };

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

// Pure: the text says all of `old` (at least three quarters of OLD's real words are in it), scored against old's words, never
// the smaller set: a guard asks "does this say the thing that went", and a short text sharing one word with it doesn't
// (review of ac5474a: "San Francisco" removed must not take "Flying to San Francisco Friday for my sister's wedding" with it).
export function covers(old: string, text: string): boolean {
  const O = new Set(words(old).map(stem)), T = new Set(words(text).map(stem));
  if (!O.size) return squash(old) === squash(text);
  let n = 0;
  for (const w of O) if (T.has(w)) n++;
  return n / O.size >= 0.75;
}

const CHAPTER_WORDS: Record<string, string> = { new_to_city: "new to the city", building_solo: "building something on your own", career_pivot: "changing careers", starting_over: "starting over" };
const CHAPTER_HINTS: Record<string, RegExp> = {
  new_to_city: /\b(new (?:to|in) (?:the )?(?:city|town|area)|just moved|recently moved|new here)\b/i,
  building_solo: /\b(building|solo|on my own|by myself|own (?:company|thing|business)|founder|indie)\b/i,
  career_pivot: /\b(career|pivot|changing (?:jobs|careers|fields)|switching|new field)\b/i,
  starting_over: /\b(starting over|fresh start|start(?:ing)? again|rebuild(?:ing)?|new chapter)\b/i,
};
// Pure: the life chapter a correction's words name (a key or its plain words), or null when it names none or more than one.
export function chapterFor(now: string): string | null {
  const t = squash(now.replace(/_/g, " "));
  const exact = Object.entries(CHAPTER_WORDS).find(([k, w]) => t === k.replace(/_/g, " ") || t === squash(w));
  if (exact) return exact[0];
  const hits = Object.keys(CHAPTER_HINTS).filter((k) => CHAPTER_HINTS[k].test(now));
  return hits.length === 1 ? hits[0] : null;
}

export type RawKnown = {
  profile: { city: string | null; long_term_direction: string | null; availability_pattern: string | null; goals: string[]; life_chapters: string[]; blockers: string[]; activity_preferences: string[]; avoid: string[]; intent: any[] } | null;
  claims: { id: string; text: string; provenance: string; kind: string; quote: string | null; live: boolean }[];
  snapshot: { work: string | null; place: string | null; wantsNow: string[]; weighingOn: string[]; valuesInPeople: string[] } | null;
  threads: { id: string; text: string; quote: string | null }[];
  kit: { key: string; value: string }[];
  tastes: { id: string; type: "room_taste" | "design_taste"; text: string; quote: string | null; inspo?: string | null }[];
  asks: { id: string; text: string }[];
  files: { n: number; sentOn: string }[];
  // Their design system (member_design_signals), the way decks and pages read it: per context with signals of its own, the look
  // and the fonts in plain words; and each confirmed reference read Co took the look from.
  design?: { context: "professional" | "personal"; look: string | null; fonts: string | null }[];
  designRefs?: { id: string; ref: string }[];
};

const CONTEXT_WORDS = { professional: "work", personal: "personal" } as const;

// Pure: their design signals, as decks and pages read them (designSystem.ts foldSignals), in plain words. Only a context with signals
// of its own; a reference read not yet confirmed is not part of it (and isn't shown).
export function designKnown(rows: any[], now: Date = new Date()): { design: NonNullable<RawKnown["design"]>; designRefs: NonNullable<RawKnown["designRefs"]> } {
  const D = designPure;
  const signals = rows.map((r) => ({
    id: Number(r.id),
    context: (r.context === "personal" ? "personal" : "professional") as "professional" | "personal",
    source: String(r.source) as any,
    values: D.cleanTokens(typeof r.vals === "string" ? JSON.parse(r.vals) : r.vals),
    quote: r.quote ? String(r.quote) : null,
    ref: r.ref ? String(r.ref) : null,
    confirmed: !!r.confirmed,
    askedAt: null,
    at: new Date(r.created_at),
    fontNotes: Array.isArray(r.font_notes) ? r.font_notes.map(String) : [],
  }));
  const design: NonNullable<RawKnown["design"]> = [];
  for (const context of ["professional", "personal"] as const) {
    const own = signals.filter((x) => x.context === context && (x.source !== "reference" || x.confirmed) && Object.keys(x.values).some((k) => k !== "cleared"));
    if (!own.length) continue;
    const f = D.foldSignals(own, context, now);
    const where = `your ${CONTEXT_WORDS[context]} decks and pages`;
    const t = f.tokens;
    const lookParts = [D.colorWords(t), t.mood ? `a ${t.mood} feel` : "", !t.display && t.type ? `${t.type} type` : "", t.density ? ({ airy: "lots of air", balanced: "balanced spacing", dense: "tight and full" } as const)[t.density] : ""].filter(Boolean);
    const look = f.dontCare ? `for ${where}, you'd rather I choose the look` : lookParts.length ? `the look of ${where}: ${lookParts.join(", ")}` : null;
    const fam = (x: { family: string } | undefined) => x?.family ?? null;
    const [hd, bd] = [fam(t.display), fam(t.body)];
    const fontLine = hd && bd ? (hd === bd ? `${hd} throughout` : `${hd} for headlines, ${bd} for text`) : hd ? `${hd} for headlines` : bd ? `${bd} for text` : "";
    const fonts = fontLine ? `the fonts in ${where}: ${fontLine}${f.fontNotes.length ? ` (${f.fontNotes.join(" ")})` : ""}` : null;
    if (look || fonts) design.push({ context, look, fonts });
  }
  const designRefs = signals
    .filter((x) => x.source === "reference" && x.confirmed && x.ref && Object.keys(x.values).length)
    .slice(0, 6)
    .map((x) => ({ id: String(x.id), ref: x.ref! }));
  return { design, designRefs };
}

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
    for (const c of p.life_chapters) add(`profile:life_chapters:${hashOf(c)}`, "profile", "where", CHAPTER_WORDS[c] ?? c.replace(/_/g, " "));
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
  for (const t of r.tastes) {
    add(`taste:${t.id}`, "taste", "likes", t.text, t.quote, false);
    // What their decks and pages take their look from (a Pinterest board, sites, brands): its own line, so "don't use that board
    // anymore" can take just that out, or point it somewhere else.
    if (t.type === "design_taste" && t.inspo) add(`inspo:${t.id}`, "inspo", "likes", `what your decks and pages take their look from: ${t.inspo}`);
  }
  // The design system decks and pages read: removal only (a new look or font is noted when they say it, with the deck tools).
  for (const d of r.design ?? []) {
    if (d.look) add(`design:${d.context}`, "design", "likes", d.look, null, false);
    if (d.fonts) add(`designfont:${d.context}`, "designfont", "likes", d.fonts, null, false);
  }
  for (const x of r.designRefs ?? []) add(`designref:${x.id}`, "designref", "likes", `a look I took from ${x.ref}, for your decks and pages`, null, false);
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
// ref is "" for a correction the turn learning made (profileExtraction.ts): those are read only to see that a value came back.
export type ForgottenRow = { field: string; old: string; now: string | null; ref: string; removed: boolean };

// Newest first. Every correction is read (the turn learning's too), so a value they put back later is seen as back.
export async function forgottenRows(userId: string, q: { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> } = pool): Promise<ForgottenRow[]> {
  const { rows } = await q.query(`SELECT pc.field, pc.old_value, pc.new_value, to_jsonb(pc)->>'item_ref' AS item_ref, to_jsonb(pc)->>'removed' AS removed FROM profile_corrections pc WHERE pc.user_id = $1 ORDER BY pc.corrected_at DESC, pc.id DESC LIMIT 300`, [userId]);
  return liveGuards(rows.map((r: any) => ({ field: String(r.field), old: String(r.old_value ?? ""), now: r.new_value == null ? null : String(r.new_value), ref: r.item_ref ? String(r.item_ref) : "", removed: r.removed === "true" || r.removed === true })));
}

// Pure: the rows that still guard, from rows newest first. Only the newest row per item counts, and a row stops guarding its old
// value once any newer correction made that value true again (Berkeley to Oakland, then Oakland back to Berkeley: Berkeley is
// theirs again, everywhere). Rows the turn learning wrote only ever release a value; they guard through their own path.
export function liveGuards(rows: ForgottenRow[]): ForgottenRow[] {
  const seen = new Set<string>();
  const out: ForgottenRow[] = [];
  rows.forEach((r, i) => {
    if (!r.ref || seen.has(r.ref)) return;
    seen.add(r.ref);
    const back = rows.slice(0, i).some((n) => n.now && squash(plainOf(n.now)) !== "" && (squash(plainOf(n.now)) === squash(plainOf(r.old)) || (covers(plainOf(r.old), n.now) && covers(n.now, plainOf(r.old)))));
    if (!back) out.push(r);
  });
  return out;
}

// Which rows guard which rebuilt thing. A row guards its own kind of source (a claim row guards claims; where they live guards
// the snapshot's place). Only a specific removal (two or more real words) from a kind that isn't a place, a role or a label guards
// other kinds, so a removed thing can't come back by another door; a city, a place, work, a kit detail or a life chapter only ever
// guards its own kind (review of ac5474a: "new to the city" must never empty a place of "New York City").
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
const OWN_KIND_ONLY = ["profile:city", "profile:availability_pattern", "profile:long_term_direction", "profile:life_chapters", "snapshot:place", "snapshot:work", "kit:", "avoid:", "file:"];
const plainOf = (t: string) => t.replace(/^(my read|looking out for|not for you|what your decks and pages take their look from): /, "");

// Pure: the row that says this text is gone (or changed), if any. rows: live guards (forgottenRows / liveGuards).
export function forgets(text: string, rows: ForgottenRow[], what: Guarded, opts: { ownOnly?: boolean } = {}): ForgottenRow | null {
  for (const r of rows) {
    if (!r.ref) continue;
    const own = GUARDED_BY[what].some((p) => r.ref.startsWith(p));
    const crosses = !opts.ownOnly && r.removed && words(r.old).length >= 2 && !OWN_KIND_ONLY.some((p) => r.ref.startsWith(p));
    if (!own && !crosses) continue;
    if (!covers(plainOf(r.old), text)) continue;
    if (r.now && covers(r.now, text)) continue;
    return r;
  }
  return null;
}

// Pure: a rebuilt snapshot with what they corrected away or removed taken out. Place and work are only ever changed by their own
// kind's rows (a corrected city gives the place its new value; a removed one empties it); lists drop what was removed.
export function forgetInSnapshot<T extends { work: string | null; place: string | null; wantsNow: string[]; weighingOn: string[]; valuesInPeople: string[] }>(s: T, rows: ForgottenRow[]): T {
  if (!rows.length) return s;
  const one = (v: string | null, what: Guarded) => {
    if (!v) return v;
    const r = forgets(v, rows, what, { ownOnly: true });
    if (!r) return v;
    return r.now ? r.now.replace(/^[a-z]+: /, "") : null;
  };
  const list = (xs: string[]) => (Array.isArray(xs) ? xs.filter((x) => !forgets(x, rows, "snapshot:list")) : xs);
  return { ...s, work: one(s.work, "snapshot:work"), place: one(s.place, "snapshot:place"), wantsNow: list(s.wantsNow), weighingOn: list(s.weighingOn), valuesInPeople: list(s.valuesInPeople) };
}

// ---------------------------------------------------------------- the raw words (their texts, Co's lines, call transcripts, recaps)

// Pure: one raw line as a reader may see it. A part of the line that says something they removed (a live removal guard covers it,
// scored against the removed text, the same strictness as every other guard) is dropped, and only that part: a line of several
// things ("Goals: a; b; c", "Wants: a, b, c") keeps the others. A line that still says what they corrected away keeps its words,
// so the conversation still reads, with the correction inline ("[since corrected: Oakland]"); a one-word value (a city) is tagged
// only where it's used as that kind ("live in Berkeley"), never in "studied at UC Berkeley". Their own ask to forget something
// keeps only that it was asked. A line carrying a safety signal (crisis or self-harm wording, services/safetyText.ts) is NEVER
// filtered, cut or rewritten: the safety reads see it whole, whatever was removed. Unrelated lines are returned as they are.
export function guardText(text: string, rows: ForgottenRow[]): string | null {
  if (!rows.length || !text.trim()) return text;
  if (safetySignal(text)) return text;
  const removed = rows.filter((r) => r.removed);
  let out = text;
  if (removed.length) {
    const kept = withoutRemovedParts(text, removed);
    if (kept === null) return null;
    out = kept;
    // "please forget the divorce stuff": the ask stays (Co should know it was asked and done), its subject doesn't.
    const own = out.match(/^\s*(User\b[^:\n]{0,40}:\s*)([\s\S]*)$/i);
    if (own && removalAsked(own[2], null) && removed.some((r) => words(plainOf(r.old)).some((w) => w.length >= 4 && new Set(words(own[2]).map(stem)).has(stem(w))))) return `${own[1]}(asked Co to forget something they'd told it; done)`;
  }
  const notes: string[] = [];
  for (const r of rows) {
    if (!r.now || !correctedSays(r.old, r.now, out)) continue;
    const now = r.now.replace(/^[a-z]+: /, "").slice(0, 80);
    if (!notes.some((n) => squash(n) === squash(now))) notes.push(now);
  }
  return notes.length ? `${out} [since corrected: ${notes.slice(0, 2).join("; ")}]` : out;
}

// Pure: the line with only the parts that say a removed thing taken out, or null when every part did. Parts: the line split on
// ";" after any lead-in ("User said:", "Goals:"), and a labelled list ("Wants: a, b, c") split on its commas.
function withoutRemovedParts(text: string, removed: ForgottenRow[]): string | null {
  const gone = (t: string) => !!forgets(t, removed, "their_words");
  if (!gone(text) && !removed.some((r) => words(plainOf(r.old)).some((w) => new Set(words(text).map(stem)).has(stem(w))))) return text;
  const m = text.match(/^(\s*[^:\n]{1,40}:\s*)([\s\S]*)$/);
  const head = m ? m[1] : "";
  const body = m ? m[2] : text;
  const isLabel = !!m && !/^\s*(User|Co)\b/i.test(head);
  let sep = /;\s*/.test(body) ? "; " : isLabel && /,\s*/.test(body) ? ", " : null;
  if (!sep) return gone(text) ? null : text;
  const parts = body.split(sep === "; " ? /;\s*/ : /,\s*/);
  const keep = parts.filter((p) => !(p.trim() && gone(p)));
  if (keep.length === parts.length) return gone(text) ? null : text;
  if (!keep.some((p) => p.trim())) return null;
  return `${head}${keep.join(sep)}`;
}

// Pure: whether a raw line still says a value they corrected away. A value of two or more real words: the line covers it (and
// doesn't already say what's true now). A one-word value: only where it's used as a place ("in", "to", "live in", "based in",
// "from", "near", or a "Where:"/"City:" line), since that's the kind of one-word value Co holds (a city), and never as part of a
// longer name ("Berkeley Rep") or after "at UC".
export function correctedSays(old: string, now: string, line: string): boolean {
  const o = plainOf(old);
  const w = words(o);
  if (!w.length || covers(now, line)) return false;
  if (w.length >= 2) return covers(o, line);
  const v = w[0].replace(/[^a-z0-9']/g, "");
  const re = new RegExp(`(?:\\b(?:live|lives|living|lived|based|located|moved|move|moving|home|from|near|around|staying|stay)\\s+(?:in\\s+|to\\s+|out of\\s+|back to\\s+|over in\\s+)?|\\b(?:in|to)\\s+|^\\W*(?:where|city|place|location|home base)\\s*:\\s*)(${v})\\b`, "gim");
  for (const m of line.matchAll(re)) {
    // Part of a longer name ("Berkeley Rep", "Berkeley Bowl") isn't the place.
    const after = line.slice((m.index ?? 0) + m[0].length);
    if (!/^\s+[A-Z]/.test(after)) return true;
  }
  return false;
}

// Pure: every line of a block through guardText (a recap, a call's system prompt), lines it drops left out.
export function guardBlock(text: string, rows: ForgottenRow[]): string {
  if (!rows.length) return text;
  return text.split("\n").map((l) => guardText(l, rows)).filter((l): l is string => l !== null).join("\n");
}

// Rows of raw words (co_memories content) for a reader: each through guardText, dropped ones left out. A failed guard read leaves
// them as they were (the reader worked that way before).
export async function guardRows<T extends { content: string }>(userId: string, rows: T[], q?: { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> }): Promise<T[]> {
  const g = await forgottenRows(userId, q).catch(() => [] as ForgottenRow[]);
  if (!g.length) return rows;
  return rows.flatMap((r) => {
    const content = guardText(String(r.content ?? ""), g);
    return content === null ? [] : [{ ...r, content }];
  });
}

// Pure: a live call's instructions through the guards (routes/callLlm.ts). Every turn of an ElevenLabs call comes through Co's own
// call brain endpoint with the whole prompt, so a correction or removal made during the call (by a tool on it, or by text) reaches
// the very next turn: the context it started with is read through the same guards. The call's own spoken turns are left as they
// are (they're this conversation, as it happens).
export function guardCallMessages<M extends { role: string; content?: unknown }>(messages: M[], rows: ForgottenRow[]): M[] {
  if (!rows.length) return messages;
  return messages.map((m) => {
    if (m.role !== "system" && m.role !== "developer") return m;
    if (typeof m.content === "string") return { ...m, content: guardBlock(m.content, rows) };
    if (Array.isArray(m.content)) return { ...m, content: m.content.map((p: any) => (p && typeof p.text === "string" ? { ...p, text: guardBlock(p.text, rows) } : p)) };
    return m;
  });
}

// Their words asking to remove or forget something, or saying it's wrong (like memberFiles.ts DELETE_ASK), or a plain yes to Co's
// own offer to remove it. A removal can't be undone, so the tool guard's "their words are in the message" isn't enough on its own
// (review of ac5474a: "what do you know" passed it).
const OBJ = "(?:that|it|this|those|these|the|my|about|everything|all|what)";
export const REMOVE_ASK = new RegExp(
  "\\b(?:remove|delete|erase|wipe|scrub|get rid of|" +
    `(?<!(?:don'?t|do not|never|did you|do you|didn'?t you|have you|you'?ll|you will|you'?d|i'?ll|i will|i'?d|i|we'?ll|we|to) )forget ${OBJ}|drop ${OBJ}|` +
    "take (?:that|it|this|those) (?:off|out|down)|(?:that'?s|that is|it'?s|its) (?:wrong|not true|not right|outdated)|not true|no longer true|isn'?t true|isn'?t right|" +
    "don'?t (?:want|need) (?:that|it|this|those) (?:on file|kept|saved|anymore)|stop (?:remembering|holding|keeping))\\b",
  "i",
);
const PLAIN_YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|please|do it|go ahead|yes please|please do|definitely|absolutely)[.!]*$/i;
// A question about what happened ("did you forget what I told you?", "have you removed it?") is not an ask; "can you forget that?" is.
const ASKED_WHETHER = /^\s*(?:did|didn'?t|have|haven'?t|has|do|does|is|are|was|were|why|when|how come)\b[^.!]*\?\s*$/i;
export function removalAsked(message: string, lastCoMessage: string | null | undefined): boolean {
  const m = message.replace(/[’‘]/g, "'");
  if (ASKED_WHETHER.test(m)) return false;
  if (REMOVE_ASK.test(m)) return true;
  const co = String(lastCoMessage ?? "");
  return PLAIN_YES.test(message.trim()) && /\b(remove|forget|delete|take (?:it|that) off|drop)\b/i.test(co) && /\?\s*$/.test(co.trim());
}

// ---------------------------------------------------------------- reading

export async function readKnown(userId: string, db: { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> } = pool): Promise<RawKnown> {
  // One at a time: on a transaction's client, queries can't overlap (pg); on the pool it costs nothing that matters here.
  let chain: Promise<unknown> = Promise.resolve();
  const q = (sql: string, args: unknown[]) => {
    const p = chain.then(() => db.query(sql, args)).then((r) => r.rows as any[]);
    chain = p.catch(() => undefined);
    return p;
  };
  const [prof, claims, snap, threads, kit, tastes, asks, files, zone, signals] = await Promise.all([
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
    // Their design system's signals, as decks and pages read them (designSystem.ts loadSignals: the same owner key and limit).
    q(`SELECT id, context, source, vals, quote, ref, confirmed, created_at, font_notes FROM member_design_signals WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 80`, [userId]),
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
      // Colors in words, never codes ("navy", not "#1F2A44"): this is what the member reads.
      return x ? [{ id: String(t.id), type: "design_taste" as const, text: D.designTasteLine({ ...x, inspo: null }).replace(/ \(their words: .*\)$/, "").replace(/#[0-9a-f]{6}\b/gi, (h) => designPure.colorName(h) || h), quote: x.quote || null, inspo: x.inspo }] : [];
    }),
    asks: asks.map((a) => ({ id: String(a.ask_id), text: String(a.ask_text ?? "") })).filter((a) => a.text.trim()),
    files,
    ...designKnown(signals),
  };
}

// What the member is shown: every item, stripped of other members' details. Throws when the names to strip can't be read (fails
// closed, PR #118): nothing unstripped is ever shown.
export async function whatCoKnows(userId: string): Promise<{ view: KnownView; items: KnownItem[] }> {
  const { memberSafeLine } = await import("./memberSafeMemories.js");
  const safe = await memberSafeLine(userId);
  const items = strippedItems(await readKnown(userId), safe);
  return { view: groupKnown(items), items };
}

// Pure: the items with other members' details stripped; an item the strip empties is left out. The ONLY items a member is shown,
// and the only ones a change can be resolved against (review of ac5474a: resolving against the raw list let a ref match a hidden
// line about another member and carry the name into the reply).
export function strippedItems(raw: RawKnown, safe: (s: string) => string | null): KnownItem[] {
  return knownItems(raw).flatMap((i) => {
    const text = safe(i.text);
    if (!text?.trim()) return [];
    // Their own words are theirs (safeMemory keeps "User said:" the same way), but a name in them is still stripped.
    const theirWords = i.theirWords ? safe(i.theirWords) : null;
    return [{ ...i, text: text.trim(), theirWords: theirWords?.trim() || null }];
  });
}

// Pure: which items a change names. An exact ref, or an exact full-line match on what the member was shown (all the items that
// say exactly those words). Nothing looser: "startup" never takes several lines with it (review of ac5474a).
export function resolveRefs(refs: string[], items: KnownItem[]): { refs: string[]; unknown: string[] } {
  const byRef = new Set(items.map((i) => i.ref));
  const out: string[] = [];
  const unknown: string[] = [];
  for (const ref of [...new Set(refs)]) {
    if (byRef.has(ref)) { out.push(ref); continue; }
    const want = squash(plainOf(ref));
    const hits = want ? items.filter((i) => squash(plainOf(i.text)) === want) : [];
    if (hits.length) out.push(...hits.map((h) => h.ref));
    else unknown.push(ref);
  }
  return { refs: [...new Set(out)], unknown };
}

// ---------------------------------------------------------------- changing

export class NotApplied extends Error {
  constructor() {
    super("no row changed");
  }
}
type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

// Applies one item's change at its source. Returns what it had and what it holds now, or why it can't.
export async function applyOne(db: Db, userId: string, raw: RawKnown, item: KnownItem, action: "correct" | "remove", now: string | null, theirWords: string): Promise<Applied | { why: string }> {
  const [kind, a, b] = item.ref.split(":");
  const was = item.text;
  if (action === "correct" && !item.canCorrect) return { why: "this kind can only be removed; remove it and note the new one with its own tool" };
  const v = action === "correct" ? now : null;
  // The row it changes must still be there: 0 rows changed is not a change (review of 3108dcf: a claim rewritten by the nightly
  // refresh under new ids was "removed" while it stayed live).
  const must = async (sql: string, args: unknown[]) => {
    const r = await db.query(sql, args);
    if (!r.rowCount) throw new NotApplied();
    return r;
  };
  switch (kind) {
    case "profile": {
      const field = a;
      if (["city", "long_term_direction", "availability_pattern"].includes(field)) {
        await must(`UPDATE co_profiles SET ${field} = $2, updated_at = NOW() WHERE user_id = $1`, [userId, v]);
        return { ref: item.ref, source: "profile", was: String((raw.profile as any)?.[field] ?? was), now: v };
      }
      if (!["goals", "life_chapters", "blockers", "activity_preferences"].includes(field)) return { why: "not a field that can change" };
      const list: string[] = ((raw.profile as any)?.[field] ?? []) as string[];
      const old = list.find((x) => hashOf(x) === b);
      if (!old) return { why: "it's no longer on file" };
      // A life chapter is one of four (profileWrite.ts ALLOWED_LIFE_CHAPTERS): the new one is the chapter their words name.
      const val = field === "life_chapters" && v ? chapterFor(v) : v;
      if (field === "life_chapters" && v && !val) return { why: `a life chapter is one of: ${Object.values(CHAPTER_WORDS).join(", ")}; ask which fits, or remove it` };
      const next = list.filter((x) => x !== old);
      if (val && !next.includes(val)) next.unshift(val);
      await must(`UPDATE co_profiles SET ${field} = $2, updated_at = NOW() WHERE user_id = $1`, [userId, next]);
      return field === "life_chapters" ? { ref: item.ref, source: "profile", was: CHAPTER_WORDS[old] ?? old, now: val ? CHAPTER_WORDS[val] : null } : { ref: item.ref, source: "profile", was: old, now: v };
    }
    case "goal": {
      // Out of the intent list entirely on a removal (a "removed" status would still read as a set-aside goal in memberKnowledge).
      const intent = raw.profile?.intent ?? [];
      const e = intent.find((x: any) => x?.id === a);
      if (!e) return { why: "it's no longer on file" };
      const next = v ? intent.map((x: any) => (x?.id === a ? { ...x, text: v, confirmed_at: new Date().toISOString() } : x)) : intent.filter((x: any) => x?.id !== a);
      await must(`UPDATE co_profiles SET intent = $2::jsonb, updated_at = NOW() WHERE user_id = $1`, [userId, JSON.stringify(next)]);
      const { goalHash } = await import("./goalEdges.js");
      await db.query(`DELETE FROM goal_states WHERE user_id = $1 AND goal_hash = $2`, [userId, goalHash(String(e.text))]).catch(() => {});
      return { ref: item.ref, source: "goal", was: String(e.text), now: v };
    }
    case "claim": {
      if (v) await must(`UPDATE member_claims SET text = $3, provenance = 'user_said', quote = $4, confirmed_on = CURRENT_DATE WHERE id = $1 AND user_id = $2`, [a, userId, v, theirWords.slice(0, 200)]);
      else await must(`DELETE FROM member_claims WHERE id = $1 AND user_id = $2`, [a, userId]);
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
      await must(`UPDATE person_snapshots SET snapshot = $2 WHERE user_id = $1`, [userId, JSON.stringify(s)]);
      return { ref: item.ref, source: "snapshot", was: old, now: v };
    }
    case "thread": {
      if (v) {
        // The same words already open another thread saying this (the one-open unique index, concurrency audit 2026-10-12).
        const clash = await must(`UPDATE member_threads SET text = $3, last_touched_at = NOW() WHERE id = $1 AND user_id = $2`, [a, userId, v]).then(
          () => false,
          (err: any) => {
            if (err?.code === "23505") return true;
            throw err;
          },
        );
        if (clash) return { why: "another open thread from the same words already says that, so this one wasn't changed" };
      } else {
        await must(`UPDATE member_threads SET status = 'changed', closed_quote = $3, closed_at = NOW() WHERE id = $1 AND user_id = $2`, [a, userId, theirWords.slice(0, 300)]);
        // Nothing left to follow up on (the same as a thread closing, memberThreads.ts applyThreadProposal).
        await db.query(`UPDATE proactive_candidates SET status = 'skipped', updated_at = NOW() WHERE user_id = $1 AND target_key = $2 AND status = 'pending'`, [userId, `thread:${a}`]).catch(() => {});
      }
      return { ref: item.ref, source: "thread", was: raw.threads.find((t) => t.id === a)?.text ?? was, now: v };
    }
    case "kit": {
      const old = raw.kit.find((k) => k.key === a)?.value ?? was;
      if (v) await must(`UPDATE member_kit SET value = $3, updated_at = NOW() WHERE user_id = $1 AND key = $2`, [userId, a, v]);
      else await must(`DELETE FROM member_kit WHERE user_id = $1 AND key = $2`, [userId, a]);
      return { ref: item.ref, source: "kit", was: `${a}: ${old}`, now: v ? `${a}: ${v}` : null };
    }
    case "taste": {
      const t = raw.tastes.find((x) => x.id === a);
      if (!t) return { why: "it's no longer on file" };
      // Design taste is one thing (its reader takes the newest), so all of it goes: an older one must not come back in its place.
      // The deck tools write the same words as a signal in their design system (agent/deckTools.ts knownTaste, the same quote), which
      // decks and pages read first: that signal goes too, on this transaction, or the look would stay. Only the signals saved from
      // this taste's own words: anything else they said about the look is its own line (design:<context>) and stays.
      if (t.type === "design_taste") {
        await must(`DELETE FROM co_memories WHERE user_id = $1 AND memory_type = 'design_taste'`, [userId]);
        // Compared as both stores keep it: the older taste's quote is whitespace-folded and cut at 200, the signal's cut at 300.
        if (t.quote) await db.query(`DELETE FROM member_design_signals WHERE owner_user_id = $1 AND source <> 'reference' AND LEFT(regexp_replace(btrim(quote), '\\s+', ' ', 'g'), 200) = LEFT($2, 200)`, [userId, t.quote]);
      } else await must(`DELETE FROM co_memories WHERE id = $1 AND user_id = $2 AND memory_type = 'room_taste'`, [a, userId]);
      return { ref: item.ref, source: "taste", was: t.text, now: null };
    }
    case "inspo": {
      // Only the inspiration changes; the rest of their look stays. A board's colors came from the board (deckTools.ts readInspo),
      // so taking a Pinterest board out takes its colors with it: decks and pages stop reading it altogether.
      const { rows } = await db.query(`SELECT content FROM co_memories WHERE id = $1 AND user_id = $2 AND memory_type = 'design_taste'`, [a, userId]);
      let j: any = null;
      try {
        j = JSON.parse(String(rows[0]?.content ?? ""));
      } catch {}
      if (!j?.inspo) return { why: "it's no longer on file" };
      const old = String(j.inspo);
      const next = { ...j, inspo: v ?? null, ...(/pinterest/i.test(old) ? { colors: { background: null, text: null, accent: null } } : {}) };
      await must(`UPDATE co_memories SET content = $3 WHERE id = $1 AND user_id = $2 AND memory_type = 'design_taste'`, [a, userId, JSON.stringify(next)]);
      // The board's read lives in their design system too (a reference signal, ref_kind 'board'): it stops counting with it.
      if (/pinterest/i.test(old)) await db.query(`UPDATE member_design_signals SET vals = '{}'::jsonb, ref = NULL, confirmed = true WHERE owner_user_id = $1 AND source = 'reference' AND ref_kind = 'board'`, [userId]);
      return { ref: item.ref, source: "inspo", was: old, now: v };
    }
    // Their design system (member_design_signals) and the older saved taste, both on this transaction. A reference read is emptied,
    // never deleted (as designSystem.ts dismissRead): the row keeps the record that its image's words are not theirs.
    case "design": {
      if (a !== "professional" && a !== "personal") return { why: "it's no longer on file" };
      const gone = await db.query(`DELETE FROM member_design_signals WHERE owner_user_id = $1 AND context = $2 AND source <> 'reference'`, [userId, a]);
      const refs = await db.query(`UPDATE member_design_signals SET vals = '{}'::jsonb, ref = NULL, confirmed = true WHERE owner_user_id = $1 AND context = $2 AND source = 'reference' AND vals <> '{}'::jsonb`, [userId, a]);
      // The older taste is read only while no signal of theirs says anything (designSystem.ts loadDesignSystem): with these gone it
      // would come back in their place.
      const legacy = await db.query(`DELETE FROM co_memories WHERE user_id = $1 AND memory_type = 'design_taste'`, [userId]);
      // The clear itself, recorded: decks for this context don't fill the look in from the other context (designSystem.ts foldSignals).
      await db.query(`INSERT INTO member_design_signals (owner_user_id, context, source, vals, confirmed) VALUES ($1, $2, 'stated', $3, true)`, [userId, a, JSON.stringify({ cleared: designPure.TOKEN_FIELDS })]);
      // Nothing changed here is still done only when nothing of it is left (an earlier line in this same change, the older taste's,
      // took it): checked, never assumed.
      if (!gone.rowCount && !refs.rowCount && !legacy.rowCount) {
        const { rows } = await db.query(`SELECT 1 FROM member_design_signals WHERE owner_user_id = $1 AND context = $2 AND vals <> '{}'::jsonb AND NOT (vals ? 'cleared') AND (source <> 'reference' OR confirmed) LIMIT 1`, [userId, a]);
        if (rows.length) throw new NotApplied();
      }
      return { ref: item.ref, source: "design", was, now: null };
    }
    case "designfont": {
      if (a !== "professional" && a !== "personal") return { why: "it's no longer on file" };
      const r = await db.query(`UPDATE member_design_signals SET vals = vals - 'display' - 'body', font_notes = '[]'::jsonb WHERE owner_user_id = $1 AND context = $2 AND (vals ? 'display' OR vals ? 'body')`, [userId, a]);
      // Recorded as a clear of the fonts here, so the other context's fonts don't fill in (designSystem.ts foldSignals).
      await db.query(`INSERT INTO member_design_signals (owner_user_id, context, source, vals, confirmed) VALUES ($1, $2, 'stated', $3, true)`, [userId, a, JSON.stringify({ cleared: ["display", "body"] })]);
      // As above: an earlier line in this change (the whole look) may have taken the fonts with it; only that counts as done.
      if (!r.rowCount) {
        const { rows } = await db.query(`SELECT 1 FROM member_design_signals WHERE owner_user_id = $1 AND context = $2 AND (vals ? 'display' OR vals ? 'body') LIMIT 1`, [userId, a]);
        if (rows.length) throw new NotApplied();
      }
      return { ref: item.ref, source: "designfont", was, now: null };
    }
    case "designref": {
      await must(`UPDATE member_design_signals SET vals = '{}'::jsonb, ref = NULL, confirmed = true WHERE id = $1 AND owner_user_id = $2 AND source = 'reference'`, [a, userId]);
      return { ref: item.ref, source: "designref", was, now: null };
    }
    case "ask": {
      const old = raw.asks.find((x) => x.id === a)?.text ?? was;
      if (v) {
        // Reworded in both places it lives (the check-in row and its intent entry); the entry's embedding is redone in the background
        // (refreshDerived), and until then the old one is dropped so matching never reads the old words.
        await must(`UPDATE ask_checkins SET ask_text = $3 WHERE user_id = $1 AND ask_id = $2`, [userId, a, v]);
        const intent = (raw.profile?.intent ?? []).map((x: any) => (x?.id === a ? { ...x, text: v, embedding: null } : x));
        await db.query(`UPDATE co_profiles SET intent = $2::jsonb, updated_at = NOW() WHERE user_id = $1`, [userId, JSON.stringify(intent)]);
      } else {
        // The same three writes as askKind.ts closeAsk, on this transaction's client.
        await must(`UPDATE ask_checkins SET resolved_at = COALESCE(resolved_at, NOW()), closed_reason = COALESCE(closed_reason, 'member'), closed_evidence = COALESCE(closed_evidence, $3) WHERE user_id = $1 AND ask_id = $2`, [userId, a, theirWords.slice(0, 300)]);
        const intent = (raw.profile?.intent ?? []).map((x: any) => (x?.id === a && x?.status === "active" ? { ...x, status: "resolved", resolved_at: new Date().toISOString() } : x));
        await db.query(`UPDATE co_profiles SET intent = $2::jsonb, updated_at = NOW() WHERE user_id = $1`, [userId, JSON.stringify(intent)]);
        await db.query(`UPDATE relevance_edges SET status = 'retired', retired_at = NOW(), retired_reason = $3 WHERE person_id = $1 AND ask_id = $2 AND status = 'open'`, [userId, a, "removed at their request"]);
      }
      return { ref: item.ref, source: "ask", was: old, now: v };
    }
    case "avoid": {
      const list = raw.profile?.avoid ?? [];
      const old = list.find((x) => hashOf(x) === a);
      if (!old) return { why: "it's no longer on file" };
      await must(`UPDATE co_profiles SET avoid = $2 WHERE user_id = $1`, [userId, list.filter((x) => x !== old)]);
      return { ref: item.ref, source: "avoid", was: old, now: null };
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
  return { claim: "what they told Co", thread: "what's going on for them", taste: "their taste", inspo: "what their decks and pages take their look from", design: "the look of their decks and pages", designfont: "the fonts in their decks and pages", designref: "a look Co took from something of theirs", ask: "what Co looks out for", avoid: "what they don't want suggested" }[kind] ?? kind;
}

// Changes items at their source, records each in the corrections record and the decision log, and refreshes what's derived.
// theirWords: their own words asking for it, from this message (checked by the tool guard's their_yes).
export async function applyKnowledgeChanges(userId: string, changes: Change[], o: { message: string; theirWords: string; lastCoMessage?: string | null }): Promise<ChangeResult> {
  // Fails closed like the view: without the names to strip, nothing is changed and nothing is said back.
  const { memberSafeLine } = await import("./memberSafeMemories.js");
  const safe = await memberSafeLine(userId);
  const clean = (t: string) => (safe(t) ?? "").trim();
  const applied: Applied[] = [];
  const refused: ChangeResult["refused"] = [];
  const changedRefs = new Set<string>();
  const removing = changes.some((c) => c.action === "remove");
  const cancelled: Cancelled[] = [];
  const asked = !removing || removalAsked(o.message, o.lastCoMessage);
  // Files go after the transaction (only memberFiles.ts touches their table), and only once everything else held.
  const fileRemovals: { item: KnownItem }[] = [];
  const decisions: Parameters<typeof recordDecision>[0][] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The nightly claims refresh rewrites a member's claims under this lock (claims.ts refreshClaims): taking it here means a claim
    // removed now can't be re-inserted from a read the refresh made before it.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('member_claims:' || $1))`, [userId]);
    // Read and resolved under the lock, on this transaction: what's changed is what's on file now, not before a refresh ran.
    const raw = await readKnown(userId, client);
    const items = strippedItems(raw, safe);
    const byRef = new Map(items.map((i) => [i.ref, i]));
    for (const c of changes) {
      if (c.action === "remove" && !asked) {
        for (const ref of c.refs) refused.push({ ref, why: "removing something needs them to ask for it in this message (remove, forget, delete, that's wrong) or say yes to your offer to remove it" });
        continue;
      }
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
      const { refs, unknown } = resolveRefs(c.refs, items);
      for (const ref of unknown) refused.push({ ref: ref.slice(0, 80), why: "not one of the items on file now (call whatCoKnows again and pass its refs)" });
      for (const ref of refs) {
        const item = byRef.get(ref)!;
        if (item.source === "file") {
          if (c.action === "remove") fileRemovals.push({ item });
          else refused.push({ ref, why: "a file can only be removed" });
          continue;
        }
        // Each item on its own savepoint: one that changed nothing is rolled back alone and reported as not done.
        await client.query("SAVEPOINT item");
        let r: Awaited<ReturnType<typeof applyOne>>;
        try {
          r = await applyOne(client, userId, raw, item, c.action, now, o.theirWords);
        } catch (err) {
          await client.query("ROLLBACK TO SAVEPOINT item");
          if (!(err instanceof NotApplied)) throw err;
          refused.push({ ref, why: "nothing changed: it was no longer on file as it was (call whatCoKnows again); tell them plainly it wasn't done yet" });
          continue;
        }
        if ("why" in r) {
          await client.query("ROLLBACK TO SAVEPOINT item");
          refused.push({ ref, why: r.why });
          continue;
        }
        // What Co had, stripped before it's returned, logged or stored: the raw row may name another member.
        const was = clean(r.was) || item.text;
        const done = { ...r, was };
        applied.push(done);
        changedRefs.add(ref);
        await client.query(`INSERT INTO profile_corrections (user_id, field, old_value, new_value, quote, item_ref, removed) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [userId, fieldFor(ref), was, r.now, clean(o.theirWords).slice(0, 300), ref, r.now == null]);
        decisions.push({ layer: 3, decision: r.now == null ? "knowledge.remove" : "knowledge.correct", userId, outcome: "act", action: r.source, proposal: { ref, was: was.slice(0, 240), now: r.now, theirWords: clean(o.theirWords).slice(0, 300) }, checks: [{ name: "their_words_in_message", pass: true }, ...(removing ? [{ name: "removal_asked", pass: true }] : []), ...(now ? [{ name: "new_value_backed", pass: true }] : [])] });
      }
    }
    // What was queued on what changed, on the same transaction (logged below, each one).
    for (const c of await cancelQueued(client, userId, applied)) {
      cancelled.push(c);
      decisions.push({ layer: 3, decision: "knowledge.cancel_queued", userId, outcome: "act", action: `${c.kind}:${c.action}`, proposal: { id: c.id, what: clean(c.what).slice(0, 160), because: c.because } });
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  for (const { item } of fileRemovals) {
    const { deleteFiles } = await import("./memberFiles.js");
    const n = Number(item.ref.split(":")[1]);
    if (!Number.isFinite(n) || !(await deleteFiles(userId, n))) {
      refused.push({ ref: item.ref, why: "that file isn't on file" });
      continue;
    }
    applied.push({ ref: item.ref, source: "file", was: `file ${n}`, now: null });
    changedRefs.add(item.ref);
    decisions.push({ layer: 3, decision: "knowledge.remove", userId, outcome: "act", action: "file", proposal: { ref: item.ref, was: `file ${n}`, now: null }, checks: [{ name: "removal_asked", pass: true }] });
  }
  for (const d of decisions) await recordDecision(d).catch(() => {});
  if (refused.length) {
    await recordDecision({ layer: 3, decision: "knowledge.change_refused", userId, outcome: "skip", action: "refused", proposal: { refused, theirWords: clean(o.theirWords).slice(0, 300) }, checks: refused.map((r) => ({ name: "change_allowed", pass: false, reason: `${r.ref}: ${r.why}` })) }).catch(() => {});
  }
  if (applied.length) void refreshDerived(userId, applied).catch((err: any) => console.error("whatCoKnows: refreshing derived copies failed (non-fatal):", err?.message ?? err));
  // What else still says it, from the fresh read (stripped like the view).
  const after = await whatCoKnows(userId).catch(() => null);
  return { ok: applied.length > 0, applied, refused, alsoSays: after ? stillSaying(after.view, applied, changedRefs) : [], cancelled: cancelled.map((c) => ({ ...c, what: clean(c.what) })) };
}

// ---------------------------------------------------------------- what's queued on what changed

// One queued thing a change took out of line (or sent back to be re-checked), for the decision log.
export type Cancelled = { kind: "candidate" | "task" | "deferred_send" | "backlog"; id: string; what: string; action: "cancelled" | "recheck"; because: string };

// Pure: whether a queued item's own text says what changed. A removal: the removed text's own words, specific removals only (two
// or more real words, not a place, a role or a label), as every guard. A correction: any kind, since a re-check only sends the item
// back to be judged again with what's true now, never drops it.
export function queuedSays(text: string, a: Applied): boolean {
  const old = plainOf(a.was);
  if (!words(old).length) return false;
  if (a.now == null) return words(old).length >= 2 && !OWN_KIND_ONLY.some((p) => a.ref.startsWith(p)) && covers(old, text);
  return correctedSays(old, a.now, text);
}

// Pure: the mark a correction leaves on a queued text: the one correction it's to be re-read against (services/deferredSends.ts).
export function recheckMark(a: Applied): string {
  return `recheck: ${JSON.stringify({ ref: a.ref.slice(0, 60), was: plainOf(a.was).slice(0, 100), now: String(a.now ?? "").slice(0, 100) })}`;
}
export function readRecheckMark(error: string | null | undefined): { ref: string; was: string; now: string } | null {
  const m = String(error ?? "").match(/^recheck:\s*(\{[\s\S]*\})\s*$/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    return typeof j?.was === "string" && typeof j?.now === "string" && j.was.trim() && j.now.trim() ? { ref: String(j.ref ?? ""), was: j.was, now: j.now } : null;
  } catch {
    return null;
  }
}

// What's waiting to go out or be worked on that rests on an item they just removed or corrected: proactive candidates (offers for
// an ask, a goal's check-in, a thread's follow-up, an ask check-in), Co's open tasks and look-outs for that ask, the network backlog
// for it, and deferred sends. Tied by id first (the ask, the goal, the thread), then by the item's own words. A removal cancels; a
// correction sends it back to be re-checked ("recheck:" is a failed attempt to the working set, services/workingSet.ts, so a find
// re-enters and is judged again with what's true now). Runs on the change's own transaction.
export async function cancelQueued(db: Db, userId: string, applied: Applied[]): Promise<Cancelled[]> {
  const out: Cancelled[] = [];
  if (!applied.length) return out;
  // One after another: this runs on the change's transaction client.
  const cands = (await db.query(`SELECT id, type, target_key, summary, payload::text AS payload FROM proactive_candidates WHERE user_id = $1 AND status = 'pending'`, [userId])).rows;
  const tasks = (await db.query(`SELECT id, goal, target_key FROM co_tasks WHERE user_id = $1 AND status = 'open'`, [userId])).rows;
  const sends = (await db.query(`SELECT id, type, target_key, messages::text AS messages, after_payload::text AS after FROM deferred_sends WHERE user_id = $1 AND status = 'queued'`, [userId])).rows;
  const done = new Set<string>();
  for (const a of applied) {
    const [kind, id] = a.ref.split(":");
    const removing = a.now == null;
    const because = `${removing ? "removed" : "corrected"} at their request: ${fieldFor(a.ref)}`;
    const tied = (key: string, payload: string) =>
      (kind === "ask" && (key.startsWith(`ask_checkin:${id}:`) || payload.includes(`"askId": "${id}"`) || payload.includes(`"askId":"${id}"`))) ||
      (kind === "goal" && (payload.includes(`"goalId": "${id}"`) || payload.includes(`"goalId":"${id}"`))) ||
      (kind === "thread" && (key === `thread:${id}` || key.startsWith(`companion:thread:${id}:`)));
    for (const c of cands) {
      const k = `c${c.id}`;
      if (done.has(k)) continue;
      if (!tied(String(c.target_key), String(c.payload)) && !queuedSays(`${c.summary}\n${c.payload}`, a)) continue;
      done.add(k);
      const action = removing ? "cancelled" : "recheck";
      const r = await db.query(`UPDATE proactive_candidates SET status = 'skipped', skip_reason = $3, decided_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'pending'`, [c.id, userId, `${action === "recheck" ? "recheck: " : ""}${because}`.slice(0, 300)]);
      if (r.rowCount) out.push({ kind: "candidate", id: String(c.id), what: `${c.type}: ${String(c.summary).slice(0, 120)}`, action, because });
    }
    for (const t of tasks) {
      const k = `t${t.id}`;
      if (done.has(k)) continue;
      const byId = kind === "ask" && String(t.target_key ?? "").startsWith(`ask_checkin:${id}`);
      if (!byId && !queuedSays(String(t.goal), a)) continue;
      done.add(k);
      if (removing) {
        const r = await db.query(`UPDATE co_tasks SET status = 'dropped', outcome = $3, closed_at = NOW(), next_check_at = NULL, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'open'`, [t.id, userId, because.slice(0, 300)]);
        if (r.rowCount) out.push({ kind: "task", id: String(t.id), what: String(t.goal).slice(0, 120), action: "cancelled", because });
      } else {
        // A task keeps going, with what's true now written on it, so its next step works from that.
        const note = JSON.stringify([{ at: new Date().toISOString(), text: `They corrected ${fieldFor(a.ref)}: now "${String(a.now).slice(0, 120)}". Work from that.` }]);
        const r = await db.query(`UPDATE co_tasks SET notes = COALESCE(notes, '[]'::jsonb) || $3::jsonb, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'open'`, [t.id, userId, note]);
        if (r.rowCount) out.push({ kind: "task", id: String(t.id), what: String(t.goal).slice(0, 120), action: "recheck", because });
      }
    }
    for (const d of sends) {
      const k = `d${d.id}`;
      if (done.has(k)) continue;
      // A correction never loses an owed text: it matches only by id or by a specific (two or more word) old value, and the text
      // stays queued, marked for a re-check, never skipped (review of 5b3dcfe: Berkeley to Oakland skipped "Here are the Berkeley
      // Rep tickets you asked about"). A removal takes out a queued text that says the removed thing.
      const byId = tied(String(d.target_key ?? ""), String(d.after ?? ""));
      if (removing ? !byId && !queuedSays(String(d.messages), a) : !byId && !(words(plainOf(a.was)).length >= 2 && queuedSays(String(d.messages), a))) continue;
      done.add(k);
      const r = removing
        ? await db.query(`UPDATE deferred_sends SET status = 'skipped', error = $3 WHERE id = $1 AND user_id = $2 AND status = 'queued'`, [d.id, userId, because.slice(0, 300)])
        : await db.query(`UPDATE deferred_sends SET error = $3 WHERE id = $1 AND user_id = $2 AND status = 'queued'`, [d.id, userId, recheckMark(a)]);
      if (r.rowCount) out.push({ kind: "deferred_send", id: String(d.id), what: `${d.type}`, action: removing ? "cancelled" : "recheck", because });
    }
    if (kind === "ask") {
      const r = await db.query(`UPDATE network_backlogs SET items = '[]'::jsonb, updated_at = NOW() WHERE user_id = $1 AND ask_id = $2 AND jsonb_array_length(items) > 0`, [userId, id]);
      if (r.rowCount) out.push({ kind: "backlog", id, what: "people lined up for this ask", action: removing ? "cancelled" : "recheck", because });
    }
  }
  return out;
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
  const stale = facts.filter((f: any) => applied.some((a) => words(plainOf(a.was)).length >= 2 && covers(plainOf(a.was), String(f.object_label)))).map((f: any) => f.id);
  if (stale.length) await pool.query(`UPDATE co_facts SET retired_at = NOW() WHERE owner_user_id = $1 AND id = ANY($2::bigint[])`, [userId, stale]);
  if (stale.length) await (await import("./peopleGraph.js")).refreshPeopleFacts(userId, { maxAgeHours: 0 }).catch(() => null);
  void import("./sweepShadow.js").then((m) => m.rerunPickerForTaste(userId)).catch(() => {});
}
