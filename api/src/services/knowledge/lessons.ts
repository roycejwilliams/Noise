// The lessons part of the member picture (Cue Memory Spec step 5, 2026-11-06): what Cue learned from their pushback, what they
// corrected, and the limits they set, each with its own date and where it came from.
//
// Royce's ruling: no prompt-length cutoffs (the newest 6 lessons, 90 days of corrections). Each decision gets a relevance budget
// instead, every item keeps a link to its source, and a newer lesson or correction QUALIFIES an older one and never erases it.
//
//   - lessons: no count, no age cutoff. Current ones first, then ones a newer lesson qualifies; within each, the ones that share words
//     with the decision (`about`), then newest. They fill a character budget; what doesn't fit is counted (lessonsOmitted), never
//     dropped silently. Each carries its date and its source: the co_memories row it was saved as. Which exchange it came from is
//     not stored (co_memories has no such column), and each says so rather than inventing one.
//   - corrections: the same. Corrections go first in the budget (lessons keep a reserve). A later correction of the same item (or one
//     whose "was" is the earlier one's "now") qualifies the earlier one: both stay, newest first, the earlier points at the later.
//   - limits: carry each item's own date when one is stored. A rule has its setAt; an avoid item (co_profiles.avoid is a plain list)
//     has none and says "undated". co_profiles.updated_at is NOT used as an item's date.
//   - guards: the same ones as transitions. Their removals (and a forget) take an item out whole; names go through the strip in
//     memberKnowledge; and if the guards could not be read, nothing is returned (fails closed).
//
// Read only, one member (user_id = $1 bound), no model, nothing written. Opt-in: include ["picture"], so the default read (and
// every prompt that renders lessons, corrections and limits today) is unchanged.
import pool from "../../db/db.js";
import type { ForgottenRow } from "../whatCoKnows.js";

type Q = { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> };

// The section's size, in characters of JSON, shared by corrections and lessons. Corrections go first; lessons keep their reserve so a
// long run of corrections can't starve them.
export const PICTURE_BUDGET_CHARS = 4000;
export const LESSONS_RESERVE_CHARS = 1200;
const CLIP = 300;
// A read bound so a runaway member can't load without limit; whatever it leaves out is counted (the *Total fields), not hidden.
const READ_BOUND = 500;

export type RawLesson = { id: string; text: string; at: Date };
export type RawCorrection = { id: string; field: string; itemRef: string; was: string; now: string | null; quote: string | null; at: Date };
export type RawPicture = { lessons: RawLesson[]; lessonsTotal: number; corrections: RawCorrection[]; correctionsTotal: number };

// Where an item came from. memoryId: the co_memories row the lesson was saved as; exchange: not stored.
export type LessonSource = { memoryId: string; exchange: "not stored" };
export type PictureLesson = { id: string; text: string; source: LessonSource; qualifiedBy: string | null; verifiedAt: string };
// A correction's own row is its source; the member's words for it are the quote (theirs, kept as said).
export type PictureCorrection = { id: string; field: string; item: string | null; was: string; now: string | null; quote: string | null; qualifiedBy: string | null; verifiedAt: string };
export type DatedAvoid = { text: string; dated: false; verifiedAt: null };
export type DatedRule = { id: string; area: string; text: string; basis: string; expiresAt: string | null; dated: true; verifiedAt: string };
export type PictureLimits = { avoid: DatedAvoid[]; rules: DatedRule[]; availability: string | null };
export type Picture = {
  lessons: PictureLesson[];
  lessonsOmitted: number;
  corrections: PictureCorrection[];
  correctionsOmitted: number;
  limits: PictureLimits;
  // A read failed (the lessons/corrections or the limits): what's here is not the whole picture. Said, never silent.
  unread?: true;
};
export type PictureOptions = { budget?: number; about?: string };

export async function loadPictureRaw(userId: string, q: Q = pool): Promise<RawPicture> {
  const [{ rows: ls }, { rows: cs }] = await Promise.all([
    q.query(`SELECT id, content, created_at, COUNT(*) OVER() AS total FROM co_memories WHERE user_id = $1 AND memory_type = 'co_lesson' ORDER BY created_at DESC LIMIT ${READ_BOUND}`, [userId]),
    // A removal is gone, never read; a transition's corrections live with the transition (thread:<id>).
    q.query(
      `SELECT pc.id, pc.field, pc.old_value, pc.new_value, pc.quote, pc.corrected_at, to_jsonb(pc)->>'item_ref' AS item_ref, COUNT(*) OVER() AS total
       FROM profile_corrections pc
       WHERE pc.user_id = $1 AND (to_jsonb(pc)->>'removed') IS DISTINCT FROM 'true' AND COALESCE(to_jsonb(pc)->>'item_ref', '') NOT LIKE 'thread:%'
       ORDER BY pc.corrected_at DESC, pc.id DESC LIMIT ${READ_BOUND}`,
      [userId],
    ),
  ]);
  return {
    lessons: ls.map((r) => ({ id: String(r.id), text: String(r.content ?? ""), at: new Date(r.created_at) })),
    lessonsTotal: ls.length ? Number(ls[0].total) : 0,
    corrections: cs.map((r) => ({ id: String(r.id), field: String(r.field), itemRef: String(r.item_ref ?? ""), was: String(r.old_value ?? ""), now: r.new_value == null ? null : String(r.new_value), quote: r.quote ?? null, at: new Date(r.corrected_at) })),
    correctionsTotal: cs.length ? Number(cs[0].total) : 0,
  };
}

// ---------------------------------------------------------------- pure

const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set(["that", "this", "with", "they", "them", "their", "have", "from", "when", "what", "about", "into", "than", "then", "will", "would", "should", "never", "always", "dont", "cue"]);
const toks = (t: string): Set<string> => new Set(squash(t).split(" ").filter((w) => w.length > 3 && !STOP.has(w)).map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w)));
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
};
const clip = (x: string) => (x.length > CLIP ? x.slice(0, CLIP) : x);
const valid = (d: Date) => !Number.isNaN(d.getTime());
// A newer lesson that says nearly the same thing again, or about the same thing, qualifies the older.
export const QUALIFIES_AT = 0.5;

// Pure: lessons with the newer one that qualifies each older (id), newest first. Nothing is removed here.
export function qualifyLessons(raw: RawLesson[]): (RawLesson & { qualifiedBy: string | null })[] {
  const sorted = raw.filter((l) => l.text.trim() && valid(l.at)).sort((a, b) => b.at.getTime() - a.at.getTime());
  const t = sorted.map((l) => toks(l.text));
  return sorted.map((l, i) => {
    let by: string | null = null;
    for (let j = i - 1; j >= 0 && by === null; j--) if (sorted[j].at.getTime() > l.at.getTime() && jaccard(t[i], t[j]) >= QUALIFIES_AT) by = sorted[j].id;
    return { ...l, qualifiedBy: by };
  });
}

// Pure: corrections with the later one that qualifies each earlier (same item, or the later one's "was" is this one's "now"), newest first.
export function qualifyCorrections(raw: RawCorrection[]): (RawCorrection & { qualifiedBy: string | null })[] {
  const sorted = raw.filter((c) => c.field.trim() && valid(c.at)).sort((a, b) => b.at.getTime() - a.at.getTime() || Number(b.id) - Number(a.id));
  return sorted.map((c, i) => {
    let by: string | null = null;
    for (let j = i - 1; j >= 0 && by === null; j--) {
      const n = sorted[j];
      const sameItem = !!c.itemRef && n.itemRef === c.itemRef;
      const chain = c.now !== null && squash(n.was) !== "" && squash(n.was) === squash(c.now);
      if (sameItem || chain) by = n.id;
    }
    return { ...c, qualifiedBy: by };
  });
}

// Pure: take items in priority order into the budget; one that doesn't fit is skipped (lighter ones after it still fill the room).
function fill<T>(ordered: T[], room: number): { kept: Set<T>; used: number } {
  const kept = new Set<T>();
  let used = 0;
  for (const it of ordered) {
    const { _t, _r, ...shown } = it as any;
    const size = JSON.stringify(shown).length;
    if (used + size > room) continue;
    kept.add(it);
    used += size;
  }
  return { kept, used };
}

// Pure: the lessons and corrections section. Rows are already guarded. Corrections take the budget first (leaving the lessons their
// reserve); each side's current items come before the qualified ones, then the ones that share words with the decision, then newest.
export function pictureOf(o: { raw: RawPicture; limits: PictureLimits; opts?: PictureOptions }): Picture {
  const budget = Math.max(0, o.opts?.budget ?? PICTURE_BUDGET_CHARS);
  const about = o.opts?.about ? toks(o.opts.about) : null;
  const rel = (text: string) => (about ? jaccard(toks(text), about) : 0);

  const cs = qualifyCorrections(o.raw.corrections).map((c): PictureCorrection & { _t: number; _r: number } => ({
    id: c.id,
    field: c.field,
    item: c.itemRef || null,
    was: clip(c.was),
    now: c.now == null ? null : clip(c.now),
    quote: c.quote == null ? null : clip(c.quote),
    qualifiedBy: c.qualifiedBy,
    verifiedAt: c.at.toISOString(),
    _t: c.at.getTime(),
    _r: rel(`${c.field} ${c.was} ${c.now ?? ""}`),
  }));
  const ls = qualifyLessons(o.raw.lessons).map((l): PictureLesson & { _t: number; _r: number } => ({
    id: l.id,
    text: clip(l.text.trim()),
    source: { memoryId: l.id, exchange: "not stored" },
    qualifiedBy: l.qualifiedBy,
    verifiedAt: l.at.toISOString(),
    _t: l.at.getTime(),
    _r: rel(l.text),
  }));
  const order = <T extends { qualifiedBy: string | null; _t: number; _r: number }>(xs: T[]) => [...xs].sort((a, b) => Number(!!a.qualifiedBy) - Number(!!b.qualifiedBy) || b._r - a._r || b._t - a._t);
  const strip = <T extends object>(x: T): Omit<T, "_t" | "_r"> => {
    const { _t, _r, ...rest } = x as any;
    return rest;
  };

  const lessonRoom = Math.min(budget, LESSONS_RESERVE_CHARS);
  const c = fill(order(cs), budget - lessonRoom);
  // Whatever corrections left unused goes to the lessons.
  const l = fill(order(ls), budget - c.used);
  const corrections = cs.filter((x) => c.kept.has(x)).sort((a, b) => b._t - a._t).map(strip) as PictureCorrection[];
  const lessons = ls.filter((x) => l.kept.has(x)).sort((a, b) => b._t - a._t).map(strip) as PictureLesson[];
  return {
    lessons,
    lessonsOmitted: ls.length - lessons.length + Math.max(0, o.raw.lessonsTotal - o.raw.lessons.length),
    corrections,
    correctionsOmitted: cs.length - corrections.length + Math.max(0, o.raw.correctionsTotal - o.raw.corrections.length),
    limits: o.limits,
  };
}

// Pure: limits with each item's own date. A rule has its setAt; an avoid item is a plain list entry with no stored date, so it says
// so (dated: false, verifiedAt: null). co_profiles.updated_at is never used as an item's date. No budget: dropping a limit is unsafe.
export function datedLimits(l: { avoid: string[]; availability: string | null; rules?: { id: string; area: string; basis: string; words: string[]; expiresAt: string | null; setAt: string }[] }, keep: (text: string) => boolean = () => true): PictureLimits {
  return {
    avoid: l.avoid.filter((a) => a.trim() && keep(a)).map((a) => ({ text: a.trim(), dated: false as const, verifiedAt: null })),
    rules: (l.rules ?? []).flatMap((r) => {
      const text = r.words.join(" / ").trim();
      const at = new Date(r.setAt);
      return text && keep(text) ? [{ id: r.id, area: r.area, text, basis: r.basis, expiresAt: r.expiresAt, dated: true as const, verifiedAt: valid(at) ? at.toISOString() : "" }] : [];
    }),
    availability: l.availability,
  };
}

// Pure: the guards. W is whatCoKnows (guardText, covers); rows are its live guards. An item that says a removed thing goes whole (a
// lesson is one instruction; cutting a part can widen it). A correction's own words are read through the removals only, never
// annotated with the correction it is.
export function guardPicture(raw: RawPicture, rows: ForgottenRow[], W: { guardText: (t: string, r: ForgottenRow[]) => string | null }): RawPicture {
  const removed = rows.filter((r) => r.removed);
  if (!removed.length) return raw;
  const same = (t: string) => W.guardText(t, removed) === t;
  return {
    ...raw,
    lessons: raw.lessons.filter((l) => same(l.text)),
    corrections: raw.corrections.filter((c) => same(c.was) && (c.now == null || same(c.now)) && (c.quote == null || same(c.quote)) && !removed.some((r) => r.ref && r.ref === c.itemRef)),
  };
}

// The empty answer, also what a failed guard read gets.
export const emptyPicture = (): Picture => ({ lessons: [], lessonsOmitted: 0, corrections: [], correctionsOmitted: 0, limits: { avoid: [], rules: [], availability: null } });
