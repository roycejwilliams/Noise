// Search quality as a system, not a vibe (Royce, 2026-10-07). Four pieces, all inside the research pipeline (services/researchBrief.ts):
//   1. The query is built from what Co knows about the member (city, budget, date, headcount, past likes and passes) and Co's
//      quality floor. A search never goes out as a bare keyword. A load-bearing constraint that's missing and can't be known is a
//      question back to the member, never a guess.
//   2. Every source read becomes fixed fields for its find type. Never prose. A missing field stays missing (shown "unknown"); a
//      hedged or interpolated value ("probably", "around", "typically") the page didn't say itself is dropped to unknown.
//   3. Every field carries its source link and the time it was checked. A stored find past a field's freshness window is re-read
//      before it's shown again; a field that can't be re-read is shown as unknown, never as still true.
//   4. Every find shown records what the member did with it (yes, no, ignored, "not like that"), and that ranks the next finds:
//      per member once there's enough of their own signal, from everyone until then.
// Trust rules stay absolute: real finds only, sources on everything, unknowns shown as unknown, no confident-wrong answers. Co is
// a private, high-end club: what it sends has to read that way (the quality floor below is part of every query).
import pool from "../db/db.js";

export type FindType = "venue" | "event";

// ---------------------------------------------------------------- 1. the query, from member state

export type MemberSearchState = {
  city: string | null;
  neighborhood: string | null;
  budget: string | null; // in their words: "$5k", "under $200 an hour"
  date: string | null; // YYYY-MM-DD
  start: string | null; // "6:00 pm"
  headcount: number | null;
  likes: string[]; // finds they said yes to before (names)
  passes: string[]; // finds they said no or "not like that" to (names, and what they said)
};

// What a find type can't be searched without. Anything else missing is searched around and shown as unknown.
export const LOAD_BEARING: Record<FindType, (keyof MemberSearchState)[]> = { venue: ["city", "headcount"], event: ["city"] };
const QUESTION: Partial<Record<keyof MemberSearchState, string>> = { city: "which city it's in", headcount: "about how many people" };

// The bar every search is held to. Co sends what a high-end private club would send, not what's cheapest or easiest to find.
export const QUALITY_FLOOR: Record<FindType, string> = {
  venue: "high-end, design-forward private event spaces with real hospitality (well-reviewed venues, restaurants' private rooms, galleries, members' spaces), not budget rentals, apartment amenity rooms or party halls",
  event: "curated, well-run rooms with a real program or host (institutions, respected organizers, invite-only or ticketed), not deal-site listings, giveaways or open mixers",
};
// Sources that don't meet the bar, whatever the search returns.
export const BELOW_THE_BAR = ["funcheap.com", "groupon.com", "craigslist.org", "allevents.in", "eventbrite.com/d/"];
export const belowTheBar = (url: string) => BELOW_THE_BAR.some((s) => url.toLowerCase().includes(s));

export type AssembledQuery = { ok: true; query: string; constraints: string[] } | { ok: false; missing: (keyof MemberSearchState)[]; question: string };

// Pure: the real question, or what to ask the member first.
export function assembleQuery(type: FindType, what: string, s: MemberSearchState): AssembledQuery {
  const missing = LOAD_BEARING[type].filter((k) => s[k] === null || s[k] === undefined || s[k] === "");
  if (missing.length) {
    const parts = missing.map((k) => QUESTION[k] ?? String(k));
    return { ok: false, missing, question: `Before I look: ${parts.join(" and ")}?` };
  }
  const constraints: string[] = [];
  constraints.push(`in ${s.neighborhood ? `${s.neighborhood}, ` : ""}${s.city}`);
  if (s.headcount) constraints.push(`for ${s.headcount} people`);
  if (s.date) constraints.push(`on ${s.date}${s.start ? ` from ${s.start}` : ""}`);
  if (s.budget) constraints.push(`budget: ${s.budget}`);
  const like = s.likes.slice(0, 3);
  const pass = s.passes.slice(0, 3);
  const query = [
    `${what.trim()}, ${constraints.join(", ")}.`,
    `Only ${QUALITY_FLOOR[type]}.`,
    like.length ? `They liked: ${like.join("; ")}.` : "",
    pass.length ? `Not like: ${pass.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return { ok: true, query, constraints };
}

// What the member's own record says: their city, and the finds they reacted to. The ask itself (headcount, date, budget) comes
// from Co, who read it in their words.
export async function loadMemberSearchState(userId: string, fromAsk: Partial<MemberSearchState>): Promise<MemberSearchState> {
  const { rows } = await pool.query(`SELECT cp.city FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  const reacted = await pool
    .query(`SELECT name, outcome, outcome_note FROM research_finds WHERE user_id = $1 AND outcome IN ('yes','no','not_like_that') ORDER BY outcome_at DESC LIMIT 12`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  return {
    city: fromAsk.city ?? rows[0]?.city ?? null,
    neighborhood: fromAsk.neighborhood ?? null,
    budget: fromAsk.budget ?? null,
    date: fromAsk.date ?? null,
    start: fromAsk.start ?? null,
    headcount: fromAsk.headcount ?? null,
    likes: reacted.rows.filter((r: any) => r.outcome === "yes").map((r: any) => String(r.name)),
    passes: reacted.rows.filter((r: any) => r.outcome !== "yes").map((r: any) => `${r.name}${r.outcome_note ? ` (${String(r.outcome_note).slice(0, 60)})` : ""}`),
  };
}

// ---------------------------------------------------------------- 2. fixed fields per find type

export type SchemaField = { key: string; label: string; ask: string; freshKey: keyof typeof FRESHNESS_HOURS };
export const FIND_SCHEMAS: Record<FindType, SchemaField[]> = {
  venue: [
    { key: "rate", label: "Rate", ask: "the rental rate, price or minimum spend as stated (with its unit, like an hour or the night)", freshKey: "price" },
    { key: "minimum", label: "Minimum", ask: "the minimum booking length", freshKey: "terms" },
    { key: "capacity", label: "Capacity", ask: "the largest group it can host, as stated (a minimum group size is not this)", freshKey: "capacity" },
    { key: "open", label: "Open", ask: "whether it is open on the date and time asked", freshKey: "availability" },
    { key: "inquire", label: "How to book", ask: "how to book or inquire: the form's page, or the email or phone given for events", freshKey: "terms" },
  ],
  event: [
    { key: "date", label: "Date", ask: "the date it happens", freshKey: "schedule" },
    { key: "start", label: "Starts", ask: "the time the program starts", freshKey: "schedule" },
    { key: "price", label: "Price", ask: "the standard price to attend in person, as stated (or free)", freshKey: "price" },
    { key: "where", label: "Where", ask: "the venue name or street address (or online only)", freshKey: "terms" },
    { key: "sold_out", label: "Sold out", ask: "whether it is sold out, only if the page says", freshKey: "availability" },
  ],
};

// A value that guesses rather than reports. Allowed only when the page itself said it that way (it's in the quoted evidence).
export const HEDGE = /\b(probably|likely|approximately|approx\.?|roughly|estimated|presumably|typically|usually|generally|seems?|appears? to|should be|may be|might be|could be|around|about)\b|~/i;
export const MAX_VALUE_CHARS = 140;
// A number stated as a floor ("16 people or more", "minimum 20", "at least 10", "15+ guests").
export const LOWER_BOUND = /\b(or more|or above|or larger|and up|minimum|at least|min\.?)(?=\W|$)|\d\s*\+(?!\s*\d)/i;

export type FieldValue = { value: string | null; evidence?: string | null };
export type FindField = { key: string; label: string; value: string | null; checkedAt: string };

// Pure: a read as the type's fixed fields, in order. Keys outside the schema are dropped; a missing key is unknown; a hedge the
// page didn't make is unknown; a long answer is replaced by the page's own words when they're short enough, else unknown.
export function schemaFields(type: FindType, read: Record<string, FieldValue | undefined>, checkedAt: string, opts: { slotLabel?: string | null } = {}): FindField[] {
  return FIND_SCHEMAS[type]
    .filter((f) => f.key !== "open" || opts.slotLabel)
    .map((f) => {
      const r = read[f.key];
      let v = r?.value?.trim() || null;
      // The label is the brief's, not the value's: "Capacity: 80 seated" under Capacity becomes "80 seated".
      if (v) v = v.replace(new RegExp(`^(${f.label}|${f.key.replace(/_/g, " ")})\\s*:\\s*`, "i"), "").trim() || null;
      const ev = r?.evidence?.trim() || null;
      if (v && HEDGE.test(v) && !(ev && HEDGE.test(ev))) v = null;
      // A capacity is the most a place holds; a floor isn't one (2026-10-07 live brief: Corzetti's "16 people or more", its
      // group-booking minimum, went out as its capacity).
      if (v && f.key === "capacity" && LOWER_BOUND.test(v)) v = null;
      if (v && v.length > MAX_VALUE_CHARS) v = ev && ev.length <= MAX_VALUE_CHARS ? ev : null;
      return { key: f.key, label: f.key === "open" && opts.slotLabel ? `Open ${opts.slotLabel}` : f.label, value: v, checkedAt };
    });
}

// ---------------------------------------------------------------- 3. freshness

// How long a field stays true enough to show without a re-check. Availability decays in days, prices in weeks.
export const FRESHNESS_HOURS = { availability: 24, price: 14 * 24, schedule: 3 * 24, terms: 30 * 24, capacity: 90 * 24 } as const;

export type StoredFind = { id?: number; type: FindType; name: string; url: string; reader: "scripted" | "sdk"; fields: FindField[] };

// Pure: the fields past their window at `now`.
export function staleKeys(f: StoredFind, now: Date): string[] {
  const schema = new Map(FIND_SCHEMAS[f.type].map((s) => [s.key, s]));
  return f.fields
    .filter((x) => {
      const s = schema.get(x.key);
      const t = new Date(x.checkedAt).getTime();
      return !s || Number.isNaN(t) || now.getTime() - t > FRESHNESS_HOURS[s.freshKey] * 3_600_000;
    })
    .map((x) => x.key);
}

// Before a stored find is shown: nothing stale, it goes as is; something stale, it's re-read first. A field the re-read couldn't
// confirm is shown as unknown (never the old value as if current), and a find whose page is gone isn't shown at all.
export async function freshForShow(f: StoredFind, reread: (f: StoredFind) => Promise<{ gone: boolean; fields: FindField[] } | null>, now = new Date()): Promise<{ find: StoredFind | null; rechecked: string[] }> {
  const stale = staleKeys(f, now);
  if (!stale.length) return { find: f, rechecked: [] };
  const r = await reread(f).catch(() => null);
  if (r?.gone) return { find: null, rechecked: stale };
  const fresh = new Map((r?.fields ?? []).map((x) => [x.key, x]));
  const fields = f.fields.map((x) => {
    if (!stale.includes(x.key)) return x;
    const n = fresh.get(x.key);
    return n ? { ...x, value: n.value, checkedAt: n.checkedAt } : { ...x, value: null, checkedAt: now.toISOString() };
  });
  return { find: { ...f, fields }, rechecked: stale };
}

// ---------------------------------------------------------------- 4. member reaction ranks the next finds

export type FindOutcome = "yes" | "no" | "ignored" | "not_like_that";
export const OUTCOME_WEIGHT: Record<FindOutcome, number> = { yes: 1, ignored: -0.15, no: -0.6, not_like_that: -1 };
export const IGNORED_AFTER_HOURS = 72;
// A member's own signal leads once they have this many reactions; until then everyone's does. Blended in between.
export const MEMBER_SIGNAL_FULL = 8;
const SMOOTH = 3; // pulls a feature seen once or twice toward zero

// Pure: what a find is, for learning. Its site, its price level and its size, read from its own fields.
export function findFeatures(f: Pick<StoredFind, "type" | "url" | "fields">): string[] {
  const out = [`type:${f.type}`];
  try {
    out.push(`site:${new URL(f.url).hostname.replace(/^www\./, "")}`);
  } catch {}
  const val = (k: string) => f.fields.find((x) => x.key === k)?.value ?? null;
  const money = (s: string | null) => (s ? Number((s.match(/\$\s?([\d,]+(?:\.\d+)?)/)?.[1] ?? "").replace(/,/g, "")) || null : null);
  if (f.type === "venue") {
    const rate = val("rate");
    const n = money(rate);
    if (n !== null && /hour|\/hr|hr\b/i.test(rate ?? "")) out.push(`price:${n < 150 ? "low" : n < 400 ? "mid" : "high"}`);
    // The largest number stated: "8 to 150 seated, 250 standing" is a large room, not a small one.
    const caps = (val("capacity")?.match(/\d[\d,]*/g) ?? []).map((x) => Number(x.replace(/,/g, ""))).filter((x) => x > 0 && x < 100_000);
    const cap = caps.length ? Math.max(...caps) : NaN;
    if (Number.isFinite(cap)) out.push(`size:${cap < 30 ? "small" : cap < 120 ? "medium" : "large"}`);
  } else {
    const p = val("price");
    if (p && /\bfree\b|\$0\b/i.test(p)) out.push("price:free");
    else {
      const n = money(p);
      if (n !== null) out.push(`price:${n < 30 ? "low" : n < 100 ? "mid" : "high"}`);
    }
  }
  return out;
}

export type FeatureStats = Record<string, { n: number; sum: number }>;
// Pure: outcome rows as per-feature stats.
export function featureStats(rows: { features: string[]; outcome: FindOutcome }[]): FeatureStats {
  const s: FeatureStats = {};
  for (const r of rows) for (const f of r.features) {
    s[f] ??= { n: 0, sum: 0 };
    s[f].n++;
    s[f].sum += OUTCOME_WEIGHT[r.outcome];
  }
  return s;
}
const weightOf = (s: FeatureStats, f: string) => (s[f] ? s[f].sum / (s[f].n + SMOOTH) : 0);

// Pure: finds ordered by what this member (or, without enough of their signal, everyone) has said yes and no to. Ties keep the
// order they came in. Ranking never drops a find; it only orders them.
export function rankFinds<T extends Pick<StoredFind, "type" | "url" | "fields">>(finds: T[], member: { stats: FeatureStats; reactions: number }, global: FeatureStats): (T & { score: number })[] {
  const a = Math.min(1, member.reactions / MEMBER_SIGNAL_FULL);
  return finds
    .map((f, i) => ({ f, i, score: findFeatures(f).reduce((sum, x) => sum + a * weightOf(member.stats, x) + (1 - a) * weightOf(global, x), 0) }))
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .map((x) => ({ ...x.f, score: Math.round(x.score * 1000) / 1000 }));
}

export async function rankingSignal(userId: string): Promise<{ member: { stats: FeatureStats; reactions: number }; global: FeatureStats }> {
  const q = (where: string, args: unknown[]) =>
    pool.query(`SELECT features, outcome FROM research_finds WHERE outcome IS NOT NULL ${where} ORDER BY outcome_at DESC LIMIT 2000`, args).then((r) => r.rows as { features: string[]; outcome: FindOutcome }[]).catch(() => []);
  const mine = await q("AND user_id = $1", [userId]);
  const all = await q("", []);
  return { member: { stats: featureStats(mine), reactions: mine.length }, global: featureStats(all) };
}

// ---------------------------------------------------------------- the record: finds shown, and what happened to them

export async function recordShownFinds(userId: string, taskId: number | null, finds: StoredFind[]): Promise<number[]> {
  const ids: number[] = [];
  for (const f of finds) {
    const { rows } = await pool
      .query(
        `INSERT INTO research_finds (user_id, task_id, find_type, name, url, reader, fields, features, checked_at, shown_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, NOW()) RETURNING id`,
        [userId, taskId, f.type, f.name.slice(0, 200), f.url, f.reader, JSON.stringify(f.fields), JSON.stringify(findFeatures(f)), minCheckedAt(f)],
      )
      .catch((err: any) => {
        console.error("recordShownFinds failed (non-fatal):", err?.message ?? err);
        return { rows: [] as any[] };
      });
    if (rows[0]?.id) ids.push(rows[0].id);
  }
  return ids;
}
const minCheckedAt = (f: StoredFind) => f.fields.map((x) => x.checkedAt).sort()[0] ?? new Date().toISOString();

// The member's reaction to one find they were shown. Only a find shown to THEM, and the first real reaction stands over "ignored".
export async function recordFindOutcome(userId: string, findId: number, outcome: Exclude<FindOutcome, "ignored">, note: string | null): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE research_finds SET outcome = $3, outcome_note = $4, outcome_at = NOW()
     WHERE user_id = $1 AND id = $2 AND shown_at IS NOT NULL AND (outcome IS NULL OR outcome = 'ignored')`,
    [userId, findId, outcome, note ? note.slice(0, 200) : null],
  );
  return (rowCount ?? 0) > 0;
}

// Finds shown and never reacted to, past the window: ignored. Runs with the task cron.
export async function markIgnoredFinds(): Promise<number> {
  const { rowCount } = await pool
    .query(`UPDATE research_finds SET outcome = 'ignored', outcome_at = NOW() WHERE outcome IS NULL AND shown_at < NOW() - ($1 || ' hours')::interval`, [String(IGNORED_AFTER_HOURS)])
    .catch(() => ({ rowCount: 0 }));
  return rowCount ?? 0;
}

// The finds this member was shown recently, for Co to match a reaction to (by number in the brief, or by name).
export async function recentShownFinds(userId: string, days = 14): Promise<{ id: number; name: string; url: string; fields: FindField[]; outcome: FindOutcome | null; shownAt: Date }[]> {
  const { rows } = await pool
    .query(`SELECT id, name, url, fields, outcome, shown_at FROM research_finds WHERE user_id = $1 AND shown_at > NOW() - ($2 || ' days')::interval ORDER BY shown_at DESC, id ASC LIMIT 20`, [userId, String(days)])
    .catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => ({ id: r.id, name: r.name, url: r.url, fields: r.fields ?? [], outcome: r.outcome, shownAt: r.shown_at }));
}

// Pure: what Co does after a reaction, as a concierge would. A yes moves toward the booking (the inquiry, then following it to an
// answer); a pass widens or changes the search. Co decides; this only says what the next step is and what it may rest on: the
// option's own sourced fields, never a price or opening beyond them.
export function nextStepAfterReaction(reaction: Exclude<FindOutcome, "ignored">, f: { name: string; url: string; fields: FindField[] }): string {
  const known = f.fields.filter((x) => x.value).map((x) => `${x.label}: ${x.value} (checked ${x.checkedAt.slice(0, 10)})`).join("; ");
  if (reaction === "yes")
    return `They want ${f.name}. Take it from here and carry it to the booking: offer in one line to draft the inquiry to the venue (draftEmail, to the contact in its fields or its page ${f.url}, with their date, headcount and budget), and if the answer will take days, take it on as a task so you follow it to a yes or no. What you may say about it: ${known || "only its name and link"}. Nothing else about price or availability.`;
  if (reaction === "not_like_that") return `Not that kind of place for them. Don't argue it. If they want more options, offer to look again with what they said, and it shapes the next search.`;
  return `Not this one. If the others don't fit either, offer to look again.`;
}

// The finds of their last brief of this type, for "send it again" / "update it": the same ask, so the same options, each put
// through freshForShow before it goes (an old one is re-read, never re-sent as if current). Ones they turned down stay out.
export async function lastBriefFinds(userId: string, type: FindType, days = 60): Promise<{ taskId: number | null; finds: StoredFind[] }> {
  const { rows } = await pool
    .query(
      `SELECT id, task_id, find_type, name, url, reader, fields FROM research_finds
       WHERE user_id = $1 AND find_type = $2 AND shown_at > NOW() - ($3 || ' days')::interval
         AND task_id = (SELECT task_id FROM research_finds WHERE user_id = $1 AND find_type = $2 AND task_id IS NOT NULL ORDER BY shown_at DESC LIMIT 1)
         AND COALESCE(outcome, '') NOT IN ('no', 'not_like_that')
       ORDER BY id ASC`,
      [userId, type, String(days)],
    )
    .catch(() => ({ rows: [] as any[] }));
  return { taskId: rows[0]?.task_id ?? null, finds: rows.map((r: any) => ({ id: r.id, type: r.find_type, name: r.name, url: r.url, reader: r.reader, fields: r.fields })) };
}
