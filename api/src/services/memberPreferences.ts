// Member preferences (Royce, 2026-11-02: "A member should be able to say how they want to be treated in ordinary conversation and
// have the relevant behavior actually change"). The case behind it: a member texted "For now only message me once per day" and the
// only record was a co_lesson hypothesis; three bursts the same morning had already gone and nothing would have held the next one.
//
// What this file does (PR A): capture, store, resolve, show and change. Enforcement at send time is harness/notifyGate.ts (PR B).
//
//   capture   one more item in the turn's existing learning read (services/turnLearning.ts, no new model call): each standing
//             instruction in what they just said, with their exact words. The model reads meaning; code only checks facts (the quote
//             is in their own message, the fields are well formed, the dates are real). Never a regex on intent.
//   store     co_facts (relation 'prefers', subject 'member', visibility 'owner'): the existing member-record table, not a settings
//             product. One row per rule; the row's meta holds the structure (below). A superseded or withdrawn rule is retired
//             (retired_at) with its state, never deleted, so the record shows what changed and nothing rebuilds it.
//   resolve   explicit beats inferred; a correction replaces only the parts it names (resolveReads, pure); a one-time request never
//             touches a standing rule; a permission (spend, share, access, act as them) is never a preference.
//   show      services/whatCoKnows.ts lists each active rule in their words, with what it covers and what it doesn't do yet;
//             removing it there withdraws it (the existing correction path).
//
// PR C (enforcement in decisions, not just sends; Royce's spec, section 3: "an SF-only preference must change the search results, not
// just the sentence introducing them"). DECISION_AREAS, each applied where the decision is made, never only in the words:
//   search_area  an explicit standing rule for everything with no place of its own is set as their search area (services/searchArea.ts
//                setSearchArea, #336's one path): sweeps, reply searches, look-outs and goals with no place look there, and what was found
//                for the old place goes. A rule for one subject only ("climbing gyms in Oakland") isn't: Cue offers that ask's own place.
//                Applied only while their area is that place (ruleApplied), so a lookup that failed or asked "which one" is never shown
//                as applied. Withdrawn: the area goes back to home.
//   reply_style  standing instructions in the reply's and the call's facts, scoped by topic, and the reply check's style read
//                (services/prefTopics.ts judgeReplyRules). Style can't be guaranteed in code: measured by tests, not enforced.
//   avoid_topic  "don't bring up X": proactive candidates and finds about X are dropped (a model read of relevance, services/prefTopics.ts),
//                replies are told not to raise it unless they do, and the reply check cuts a sentence that raises it.
// "other" stays unsupported: stored, shown with "noted, not applied yet", and the reply offers what Cue can do instead.
// ENFORCED_AREAS stays the send-time list (harness/notifyGate.ts holds sends on those alone).
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { wordsZone } from "./memberTime.js";
import { normName, parseQualified } from "./placeResolve.js";

export type PrefArea = "contact" | "checkins" | "search_area" | "reply_style" | "avoid_topic" | "other";
export type PrefChannel = "text" | "call" | "all";
// What a contact rule covers: every message Cue sends them that isn't its reply to their text (deliveries they asked for and notices
// included), only what Cue starts on its own, or only check-ins.
export type PrefCovers = "all" | "unsolicited" | "checkins";
export type PrefRule = {
  maxPerDay?: number;
  maxPerWeek?: number;
  // Weekdays, 1 = Monday .. 7 = Sunday, in their zone.
  noDays?: number[];
  onlyDays?: number[];
  // Local "HH:MM": nothing before earliest, nothing after latest.
  earliest?: string;
  latest?: string;
  // Nothing at all (within what the rule covers) while it's in force: "no check-ins this week", "stop for a week".
  none?: boolean;
  // "Text me less" with no measure: never turned into a number Cue made up. Cue asks once how often works.
  less?: boolean;
  // PR C areas: where to search, how to reply, what about.
  place?: string;
  style?: string;
  topic?: string;
};
export type PrefState = "active" | "superseded" | "withdrawn" | "expired";
export type Preference = {
  id: string;
  area: PrefArea;
  channel: PrefChannel;
  covers: PrefCovers;
  rule: PrefRule;
  basis: "explicit" | "inferred";
  // "standing" (until changed or until its expiry) or "one_time" (an exception for one thing: stored and shown, never loosens a standing
  // rule and never erases one).
  type: "standing" | "one_time";
  // Their words, newest last (a correction adds its words to what it merged).
  words: string[];
  source: { via: "text" | "call"; ref: string | null };
  startsAt: string | null;
  expiresAt: string | null;
  zone: string;
  state: PrefState;
  setAt: string;
  // A vague "less": whether Cue has asked how often works (asked once, never again).
  askedAt?: string | null;
  // A where-to-search rule: the exact place their search area was set to for it (searchArea.ts), once it was ("Springfield,
  // Missouri" for "Springfield" after they said which). What it's held against and what its withdrawal clears.
  areaPlace?: string | null;
  // A where-to-search rule whose area couldn't be set (a place lookup down): its retries (retryAreaRules) and, after the last, that it
  // was given up and when they were told.
  areaRetry?: { tries: number; lastAt: string | null; gaveUp: boolean; toldAt: string | null } | null;
};

export const PREF_AREAS: readonly PrefArea[] = ["contact", "checkins", "search_area", "reply_style", "avoid_topic", "other"];
// The areas the send gate enforces (harness/notifyGate.ts reads this list: only rules about when and how often Cue sends).
export const ENFORCED_AREAS: ReadonlySet<PrefArea> = new Set<PrefArea>(["contact", "checkins"]);
// The areas applied where decisions are made (PR C): where searches run, how replies are written, what Cue brings up. Whether one
// rule is applied right now is ruleApplied's answer (a search area only while it's really set there).
export const DECISION_AREAS: ReadonlySet<PrefArea> = new Set<PrefArea>(["search_area", "reply_style", "avoid_topic"]);

const DAY_NAMES: Record<string, number> = { mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7 };
const DAY_WORDS = ["", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];

// ---------------------------------------------------------------- the read (one item of turnLearning's prompt)

// Pure: the prompt item. onFile: their active rules, numbered, so a change or a withdrawal can name the one it changes.
export function preferencePromptItem(o: { n: number; via?: "text" | "call"; onFile: Pick<Preference, "area" | "covers" | "channel" | "rule" | "words" | "basis" | "type">[]; localToday: string }): string {
  const listed = o.onFile.length
    ? `\nRules on file (numbered):\n${o.onFile.map((p, i) => `${i}. ${p.area}/${p.covers}/${p.channel} ${JSON.stringify(p.rule)} (${p.basis}${p.type === "one_time" ? ", one time" : ""}; their words: "${(p.words[p.words.length - 1] ?? "").slice(0, 160)}")`).join("\n")}\n`
    : "";
  return `${o.n}. preferences: standing instructions in what they just said about how Cue should treat them: how often or when Cue may text or call them first, check-ins, where to look for things, how Cue should reply (how often or when Cue reaches out goes here, not in style). Their local date today is ${o.localToday}.${listed}
  - Only the person's own instruction ${o.via === "call" ? "in their own lines on this call (the \"user\" lines). Not Cue's lines" : "in their LAST message. Not an earlier message"}, not something they quote or forward, not what someone else said or wants, not Cue's suggestion.
  - Not a preference: a fact about now ("I'm busy today", "I'm traveling"), a goal, a single request ("send me that link"), small talk. "I'm busy today" is never "don't contact me".
  - type "standing": a rule until they change it; give expires_on when they bound it ("this week", "for a few days", "until Friday"), resolved from today. type "one_time": an exception for one thing or one moment ("text me tonight about this one even though it's late"); it never changes a standing rule. type "withdraw": they lift a rule on file (give its number in replaces). type "permission": anything that would let Cue spend money, share their details or someone else's, give anyone access, or speak or act as them: never a preference, report it as type "permission" with nothing else.
  - area: "contact" (texts or calls Cue sends them), "checkins" (only check-ins), "search_area" (where to look for events or things; rule.place, and rule.topic only when it's for one subject, not events or things in general), "reply_style" (how to reply; rule.style and, if it's for a subject, rule.topic), "avoid_topic" (a subject Cue shouldn't bring up or suggest things about; rule.topic, in a few words), "other" (rule.topic says what).
  - covers (contact only): "all" (every message Cue sends that isn't its reply to their text, things they asked for and urgent ones included: "message me", "notifications", "texts"), "unsolicited" (only what Cue starts on its own: "don't reach out", "stop sending me events"), "checkins" (only check-ins). channel: "text", "call" or "all".
  - rule, only what they said: max_per_day, max_per_week (numbers they gave), no_days / only_days (day names), earliest / latest ("HH:MM", 24h, their time), none (true: nothing at all while it lasts), less (true: they want less with no measure; NEVER make up a number).
  - basis "explicit" when they said it outright; "inferred" only when it's their own words that clearly imply it without stating a rule (still a quote of theirs).
  - replaces: numbers of rules on file this changes. Give only the parts that change; anything they didn't mention stays as it was.
  - quote: their exact words, copied from ${o.via === "call" ? "their own line on the call" : "their last message"} (at least a few words).`;
}
export const PREFERENCE_JSON_SHAPE = `"preferences": [{"type": "standing" | "one_time" | "withdraw" | "permission", "area": "contact", "covers": "all", "channel": "all", "basis": "explicit", "rule": {"max_per_day": null, "max_per_week": null, "no_days": null, "only_days": null, "earliest": null, "latest": null, "none": false, "less": false, "place": null, "style": null, "topic": null}, "expires_on": null, "replaces": [], "quote": "..."}]`;

export type PreferenceRead = {
  type: "standing" | "one_time" | "withdraw" | "permission";
  area: PrefArea;
  covers: PrefCovers;
  channel: PrefChannel;
  basis: "explicit" | "inferred";
  rule: PrefRule;
  expiresOn: string | null;
  replaces: number[];
  quote: string;
};

const squash = (t: string) => t.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
// Pure: the quote is theirs, from this message (a fact check, not a reading of intent). Words that sit only inside quotation marks in
// their message are someone else's, quoted (spec: "quoted messages aren't automatically the member's instructions").
// Also out: single-quoted spans ('...' or ‘...’, never an apostrophe inside a word) and bracketed notes Cue added to their message
// ("[sent a photo showing: ...]", a file's note).
export function ownWords(message: string): string {
  return message
    .replace(/\[[^\]\n]*\]/g, " ")
    .replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|‘[^’\n]*’/g, " ")
    .replace(/(^|[\s(\[:])'[^'\n]+'(?=$|[\s.,!?;:)\]])/g, "$1 ");
}
export function quoteIsTheirs(quote: string, message: string): boolean {
  const q = squash(quote);
  if (q.length < 4 || !squash(message).includes(q)) return false;
  return squash(ownWords(message)).includes(q);
}
const int = (v: unknown, max: number): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= max ? n : undefined;
};
const days = (v: unknown): number[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.map((d) => (typeof d === "number" && d >= 1 && d <= 7 ? d : DAY_NAMES[String(d).toLowerCase().trim()])).filter((d): d is number => !!d))].sort();
  return out.length && out.length < 7 ? out : undefined;
};
const hhmm = (v: unknown): string | undefined => {
  const m = typeof v === "string" ? v.trim().match(/^(\d{1,2}):(\d{2})$/) : null;
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, "0")}:${m[2]}` : undefined;
};
const text = (v: unknown, n = 120): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);

// Pure: one rule from the model's fields; undefined fields are left out, so a merge only replaces what was said.
export function ruleFrom(r: any): PrefRule {
  const out: PrefRule = {};
  if (!r || typeof r !== "object") return out;
  const d = int(r.max_per_day ?? r.maxPerDay, 50);
  if (d !== undefined) out.maxPerDay = d;
  const w = int(r.max_per_week ?? r.maxPerWeek, 200);
  if (w !== undefined) out.maxPerWeek = w;
  const nd = days(r.no_days ?? r.noDays);
  if (nd) out.noDays = nd;
  const od = days(r.only_days ?? r.onlyDays);
  if (od) out.onlyDays = od;
  const e = hhmm(r.earliest);
  if (e) out.earliest = e;
  const l = hhmm(r.latest);
  if (l) out.latest = l;
  if (r.none === true) out.none = true;
  if (r.less === true) out.less = true;
  const place = text(r.place, 80);
  if (place) out.place = place;
  const style = text(r.style, 200);
  if (style) out.style = style;
  const topic = text(r.topic, 120);
  if (topic) out.topic = topic;
  return out;
}

// Pure: only the fields an area's path reads (a structure check, not a reading of intent). Where to search, how to reply and what not
// to bring up never carry a send limit, so nothing in them can hold a send; a send rule keeps every field as PR A stored it.
const NOT_SEND: ReadonlySet<PrefArea> = new Set<PrefArea>(["search_area", "reply_style", "avoid_topic"]);
export function ruleForArea(area: PrefArea, r: PrefRule): PrefRule {
  if (!NOT_SEND.has(area)) return r;
  const keep: (keyof PrefRule)[] = area === "search_area" ? ["place", "topic"] : area === "reply_style" ? ["style", "topic"] : ["topic"];
  return Object.fromEntries(Object.entries(r).filter(([k]) => keep.includes(k as keyof PrefRule))) as PrefRule;
}

// Pure: the model's list, kept only where the quote is in their message and the fields are real. A read that names something this
// code can't hold is dropped, never guessed into a rule.
export function parsePreferenceReads(raw: unknown, message: string, localToday: string): PreferenceRead[] {
  if (!Array.isArray(raw)) return [];
  const out: PreferenceRead[] = [];
  for (const p of raw.slice(0, 6)) {
    if (!p || typeof p !== "object") continue;
    const type = ["standing", "one_time", "withdraw", "permission"].includes(p.type) ? p.type : null;
    const quote = typeof p.quote === "string" ? p.quote.trim().slice(0, 300) : "";
    if (!type || !quoteIsTheirs(quote, message)) continue;
    const area: PrefArea = PREF_AREAS.includes(p.area) ? p.area : "other";
    const covers: PrefCovers = area === "checkins" ? "checkins" : ["all", "unsolicited", "checkins"].includes(p.covers) ? p.covers : "unsolicited";
    const channel: PrefChannel = ["text", "call", "all"].includes(p.channel) ? p.channel : "all";
    const exp = typeof p.expires_on === "string" && DateTime.fromISO(p.expires_on).isValid ? p.expires_on.slice(0, 10) : null;
    // A bound in the past or more than a year out isn't a date they gave: the rule stands without it.
    const expiresOn = exp && exp >= localToday && exp <= DateTime.fromISO(localToday).plus({ days: 366 }).toISODate()! ? exp : null;
    const replaces = Array.isArray(p.replaces) ? p.replaces.filter((n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0) : [];
    out.push({ type, area, covers, channel, basis: p.basis === "inferred" ? "inferred" : "explicit", rule: ruleForArea(area, ruleFrom(p.rule)), expiresOn, replaces, quote });
  }
  return out;
}

// ---------------------------------------------------------------- resolving a read against what's on file

export type NewPref = Omit<Preference, "id" | "state" | "setAt" | "askedAt" | "areaPlace">;
export type PrefChanges = {
  add: NewPref[];
  // Rows retired by this turn: superseded by a new version (merged), or withdrawn.
  retire: { id: string; state: "superseded" | "withdrawn" }[];
  // Reads not applied, and why (logged with ids and kinds only).
  refused: { kind: string; why: string }[];
};

// Pure: whether a rule says something a path could act on.
export function hasEffect(r: PrefRule): boolean {
  return Object.keys(r).length > 0;
}
// A rule for one subject is its own scope (spec, section 2: "specific preferences apply within their scope; general preferences still
// apply elsewhere"): "keep work replies short" and "explain technical things fully" never replace each other unless one is named.
const topicKey = (r: PrefRule) => (r.topic ? squash(r.topic) : "");
const sameScope = (a: Pick<Preference, "area" | "covers" | "channel" | "type" | "rule">, b: Pick<Preference, "area" | "covers" | "channel" | "type" | "rule">) =>
  a.area === b.area && a.covers === b.covers && a.channel === b.channel && a.type === b.type && (!NOT_SEND.has(a.area) || topicKey(a.rule) === topicKey(b.rule));

// Pure: what the turn's reads change. Precedence (Royce's spec, section 2):
//   - a permission is never a preference (refused, logged by kind);
//   - a one-time request is stored on its own and never retires a standing rule;
//   - a withdrawal retires only the rules it names;
//   - a change merges into the rule it replaces (named, or the one active rule of the same scope): the parts it names replace the old
//     ones, everything else stays (a correction replaces only the conflicting part);
//   - an inferred read never replaces an explicit rule; an explicit one replaces an inferred one.
export function resolveReads(onFile: Preference[], reads: PreferenceRead[], ctx: { now: Date; zone: string | null; source: Preference["source"] }): PrefChanges {
  const zone = wordsZone(ctx.zone);
  const out: PrefChanges = { add: [], retire: [], refused: [] };
  const retired = new Set<string>();
  for (const r of reads) {
    if (r.type === "permission") {
      out.refused.push({ kind: "permission", why: "a preference never grants spending, sharing, access or acting as them" });
      continue;
    }
    const named = r.replaces.map((i) => onFile[i]).filter((p): p is Preference => !!p && !retired.has(p.id));
    if (r.type === "withdraw") {
      if (!named.length) out.refused.push({ kind: "withdraw", why: "names no rule on file" });
      for (const p of named) {
        retired.add(p.id);
        out.retire.push({ id: p.id, state: "withdrawn" });
      }
      continue;
    }
    if (!hasEffect(r.rule)) {
      out.refused.push({ kind: r.area, why: "nothing a path could act on" });
      continue;
    }
    const type = r.type === "one_time" ? "one_time" : "standing";
    const scope = { area: r.area, covers: r.covers, channel: r.channel, type, rule: r.rule } as const;
    // One-time requests never replace anything.
    const target = type === "one_time" ? [] : named.length ? named.filter((p) => p.type === "standing") : onFile.filter((p) => !retired.has(p.id) && sameScope(p, scope));
    if (r.basis === "inferred" && target.some((p) => p.basis === "explicit")) {
      out.refused.push({ kind: r.area, why: "an inferred read never replaces what they said outright" });
      continue;
    }
    let rule: PrefRule = { ...r.rule };
    let words = [r.quote];
    for (const p of target) {
      // Only the parts this read names replace the old; a number replaces a vague "less" (that's the answer to the one ask).
      rule = { ...p.rule, ...r.rule };
      if (r.rule.maxPerDay !== undefined || r.rule.maxPerWeek !== undefined || r.rule.none) delete rule.less;
      if (r.rule.noDays && rule.onlyDays) delete rule.onlyDays;
      if (r.rule.onlyDays && rule.noDays) delete rule.noDays;
      words = [...p.words, r.quote].slice(-4);
      retired.add(p.id);
      out.retire.push({ id: p.id, state: "superseded" });
    }
    const expiresAt = r.expiresOn ? DateTime.fromISO(r.expiresOn, { zone }).endOf("day").toJSDate().toISOString() : type === "one_time" ? DateTime.fromJSDate(ctx.now).setZone(zone).endOf("day").toJSDate().toISOString() : null;
    out.add.push({ area: r.area, channel: r.channel, covers: r.covers, rule, basis: r.basis, type, words, source: ctx.source, startsAt: ctx.now.toISOString(), expiresAt, zone });
  }
  return out;
}

// Pure: in force now (not retired, started, not past its expiry). Expiry is the instant the named day ended in the zone they were in
// when they said it (a "this week" said in New York ends there); day and hour rules are read in their current zone at send time
// (harness/notifyGate.ts), so a member who moves keeps "not before 10" at 10 where they are.
export function inForce(p: Pick<Preference, "state" | "startsAt" | "expiresAt">, now: Date): boolean {
  if (p.state !== "active") return false;
  if (p.startsAt && Date.parse(p.startsAt) > now.getTime()) return false;
  return !p.expiresAt || Date.parse(p.expiresAt) > now.getTime();
}

// ---------------------------------------------------------------- storage (co_facts, relation 'prefers')

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
export const PREF_RELATION = "prefers";

function rowToPref(r: any): Preference | null {
  const m = r.meta ?? {};
  if (!m.pref) return null;
  const state: PrefState = r.retired_at ? (m.state === "withdrawn" ? "withdrawn" : m.state === "expired" ? "expired" : "superseded") : "active";
  return {
    id: String(r.id),
    area: PREF_AREAS.includes(m.area) ? m.area : "other",
    channel: m.channel ?? "all",
    covers: m.covers ?? "unsolicited",
    rule: ruleForArea(PREF_AREAS.includes(m.area) ? m.area : "other", ruleFrom(m.ruleRaw ?? {})),
    basis: m.basis === "inferred" ? "inferred" : "explicit",
    type: m.type === "one_time" ? "one_time" : "standing",
    words: Array.isArray(m.words) ? m.words.map(String) : [String(r.object_label ?? "")],
    source: m.source ?? { via: "text", ref: null },
    startsAt: m.startsAt ?? null,
    expiresAt: m.expiresAt ?? null,
    zone: m.zone ?? wordsZone(null),
    state,
    setAt: new Date(r.happened_at).toISOString(),
    askedAt: m.askedAt ?? null,
    areaPlace: typeof m.areaPlace === "string" ? m.areaPlace : null,
    areaRetry: m.areaRetry && typeof m.areaRetry === "object" ? { tries: Number(m.areaRetry.tries) || 0, lastAt: m.areaRetry.lastAt ?? null, gaveUp: m.areaRetry.gaveUp === true, toldAt: m.areaRetry.toldAt ?? null } : null,
  };
}
// The rule as stored: the model's field names, so ruleFrom reads it back through the same validation.
const ruleRaw = (r: PrefRule) => ({ max_per_day: r.maxPerDay, max_per_week: r.maxPerWeek, no_days: r.noDays, only_days: r.onlyDays, earliest: r.earliest, latest: r.latest, none: r.none, less: r.less, place: r.place, style: r.style, topic: r.topic });

// Their rules, active ones first. withRetired: the record of what changed too. Every statement is one member's (owner_user_id = $1).
export async function loadPreferences(userId: string, db: Db = pool, o: { withRetired?: boolean } = {}): Promise<Preference[]> {
  const { rows } = await db.query(
    `SELECT id, object_label, happened_at, retired_at, meta FROM co_facts
     WHERE owner_user_id = $1 AND relation = '${PREF_RELATION}' AND subject = 'member' ${o.withRetired ? "" : "AND retired_at IS NULL"}
     ORDER BY happened_at ASC, id ASC LIMIT 200`,
    [userId],
  );
  return rows.map(rowToPref).filter((p): p is Preference => !!p);
}
// The rules in force now.
export async function activePreferences(userId: string, now: Date = new Date(), db: Db = pool): Promise<Preference[]> {
  return (await loadPreferences(userId, db)).filter((p) => inForce(p, now));
}

// Writes a turn's changes in one transaction: retire first, then add. The decision log carries ids, kinds and counts, never their words.
export async function storePreferenceChanges(userId: string, ch: PrefChanges, o: { now?: Date } = {}): Promise<{ added: string[]; retired: string[] }> {
  const now = o.now ?? new Date();
  if (!ch.add.length && !ch.retire.length) {
    if (ch.refused.length) await recordDecision({ layer: 4, decision: "member.preference", userId, outcome: "skip", action: "refused", proposal: { refused: ch.refused } }).catch(() => {});
    return { added: [], retired: [] };
  }
  const client = await pool.connect();
  const added: string[] = [];
  const retired: string[] = [];
  try {
    await client.query("BEGIN");
    for (const r of ch.retire) {
      const u = await client.query(
        `UPDATE co_facts SET retired_at = $3, meta = meta || jsonb_build_object('state', $4::text) WHERE id = $1 AND owner_user_id = $2 AND relation = '${PREF_RELATION}' AND retired_at IS NULL`,
        [r.id, userId, now, r.state],
      );
      if (u.rowCount) retired.push(r.id);
    }
    for (const p of ch.add) {
      const ins = await client.query(
        `INSERT INTO co_facts (owner_user_id, subject, relation, object_label, object_key, visibility, source, happened_at, meta)
         VALUES ($1, 'member', '${PREF_RELATION}', $2, $3, 'owner', $4, $5, $6::jsonb) RETURNING id`,
        [userId, p.words[p.words.length - 1].slice(0, 500), `pref:${now.getTime()}:${added.length}`, `preference:${p.source.via}`, now, JSON.stringify({ pref: 1, area: p.area, channel: p.channel, covers: p.covers, basis: p.basis, type: p.type, ruleRaw: ruleRaw(p.rule), words: p.words, source: p.source, startsAt: p.startsAt, expiresAt: p.expiresAt, zone: p.zone })],
      );
      added.push(String(ins.rows[0].id));
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await recordDecision({
    layer: 4,
    decision: "member.preference",
    userId,
    outcome: "act",
    action: added.length ? "stored" : "retired",
    proposal: { added, retired, kinds: ch.add.map((p) => ({ area: p.area, covers: p.covers, channel: p.channel, basis: p.basis, type: p.type, fields: Object.keys(p.rule), expires: !!p.expiresAt })), refused: ch.refused },
  }).catch(() => {});
  return { added, retired };
}

// Withdraws one rule (what-Cue-knows removal). Returns whether a row changed.
// Their words go with it (object_label and meta.words blanked, the free-removal ruling): only the structure and its state stay, so
// nothing can read the rule back from its record. A twin the same words wrote elsewhere goes in the same change: the call cadence
// (meta.twins.callCadence, set by the learning read that saw both).
export async function withdrawPreference(db: Db, userId: string, id: string, now: Date = new Date()): Promise<boolean> {
  const r = await db.query(
    `UPDATE co_facts SET retired_at = $3, object_label = '', meta = (meta - 'words') || '{"state":"withdrawn","words":[]}'::jsonb
     WHERE id = $1 AND owner_user_id = $2 AND relation = '${PREF_RELATION}' AND retired_at IS NULL RETURNING meta`,
    [id, userId, now],
  );
  if (!r.rowCount) return false;
  const meta = (r.rows[0]?.meta ?? {}) as any;
  if (meta.twins?.callCadence) await db.query(`UPDATE co_profiles SET checkin_call_cadence_days = NULL WHERE user_id = $1`, [userId]);
  // A where-to-search rule that set their area: the area goes back to home with it (only while it's still that place), and what was
  // found there goes, in the same transaction (PR C).
  const was = rowToPref({ id, object_label: "", happened_at: now, retired_at: null, meta });
  if (was && areaRuleAppliable(was) && was.areaPlace) await (await import("./searchArea.js")).clearAreaIn(db, userId, { because: "the rule that set their search area was removed", onlyPlace: was.areaPlace });
  return true;
}
// The same learning read wrote a call cadence from the words that set these rules: they're one thing, withdrawn together.
export async function markCadenceTwin(userId: string, ids: string[], db: Db = pool): Promise<void> {
  if (!ids.length) return;
  await db.query(`UPDATE co_facts SET meta = jsonb_set(meta, '{twins,callCadence}', 'true'::jsonb, true) WHERE owner_user_id = $1 AND id = ANY($2::bigint[]) AND relation = '${PREF_RELATION}'`, [userId, ids.map(Number)]);
}

// The vague "less": asked once. The reply's facts hand it the ask (noteLessAsk); it's marked asked only once that reply was actually
// sent (confirmLessAsked, from the turn's send), so a reply that never went asks again next time.
const pendingLessAsk = new Map<string, string[]>();
export function noteLessAsk(userId: string, ids: string[]): void {
  if (ids.length) pendingLessAsk.set(userId, ids);
  else pendingLessAsk.delete(userId);
}
export async function confirmLessAsked(userId: string, db: Db = pool): Promise<void> {
  // A search area given up on (retryAreaRules) counts as told once a reply carrying it went, from the same send.
  const told = pendingAreaNotice.get(userId);
  if (told?.length) {
    pendingAreaNotice.delete(userId);
    await markAreaTold(userId, told, new Date(), db);
  }
  const ids = pendingLessAsk.get(userId);
  if (!ids?.length) return;
  pendingLessAsk.delete(userId);
  await markLessAsked(userId, ids, new Date(), db);
}
const pendingAreaNotice = new Map<string, string[]>();
export function noteAreaNotice(userId: string, ids: string[]): void {
  if (ids.length) pendingAreaNotice.set(userId, ids);
  else pendingAreaNotice.delete(userId);
}
export async function markAreaTold(userId: string, ids: string[], now: Date = new Date(), db: Db = pool): Promise<void> {
  if (!ids.length) return;
  await db.query(`UPDATE co_facts SET meta = jsonb_set(meta, '{areaRetry,toldAt}', to_jsonb($3::text), true) WHERE owner_user_id = $1 AND id = ANY($2::bigint[]) AND relation = '${PREF_RELATION}' AND meta ? 'areaRetry'`, [userId, ids.map(Number), now.toISOString()]);
}
export async function markLessAsked(userId: string, ids: string[], now: Date = new Date(), db: Db = pool): Promise<void> {
  if (!ids.length) return;
  await db.query(`UPDATE co_facts SET meta = meta || jsonb_build_object('askedAt', $3::text) WHERE owner_user_id = $1 AND id = ANY($2::bigint[]) AND relation = '${PREF_RELATION}'`, [userId, ids.map(Number), now.toISOString()]);
}

// The turn's reads, resolved and stored (services/turnLearning.ts, and the call's learning). Non-fatal for the caller.
export async function learnPreferences(userId: string, raw: unknown, o: { message: string; zone: string | null; now?: Date; source: Preference["source"]; onFile?: Preference[] }): Promise<{ added: string[]; retired: string[] }> {
  const now = o.now ?? new Date();
  const localToday = DateTime.fromJSDate(now).setZone(wordsZone(o.zone)).toISODate()!;
  const reads = parsePreferenceReads(raw, o.message, localToday);
  if (!reads.length) return { added: [], retired: [] };
  const onFile = o.onFile ?? (await activePreferences(userId, now));
  const changes = resolveReads(onFile, reads, { now, zone: o.zone, source: o.source });
  const stored = await storePreferenceChanges(userId, changes, { now });
  // Where the decision is made (PR C): their search area set or cleared, what's waiting about a subject they don't want raised dropped.
  // Awaited, so the reply (or the call's follow-up) sees the change it says was made. Non-fatal: the rule is stored either way, and
  // until its effect is real it's shown and said as not applied (ruleApplied).
  await applyRuleEffects(userId, changes, stored, { message: o.message, onFile }).catch((err: any) => console.error("memberPreferences: applying a rule failed (non-fatal; shown as not applied):", err?.message ?? err));
  return stored;
}

// ---------------------------------------------------------------- effects where decisions are made (PR C)

export type RuleEffects = {
  // services/searchArea.ts setSearchArea, #336's one path (resolved against their home; ambiguous or unresolved changes nothing).
  setArea: (userId: string, input: { place: string; theirWords: string; message: string }) => Promise<import("./searchArea.js").SetAreaResult>;
  // Back to home, only while the area is still that place.
  clearArea: (userId: string, place: string, because: string) => Promise<boolean>;
  // services/prefTopics.ts dropTopicWork: what's waiting about the subject leaves.
  dropTopic: (userId: string, topic: string, ruleId: string) => Promise<unknown>;
};
const realEffects: RuleEffects = {
  setArea: async (userId, input) => {
    const A = await import("./searchArea.js");
    return A.setSearchArea(userId, input, A.realSetAreaDeps());
  },
  clearArea: async (userId, place, because) => {
    const A = await import("./searchArea.js");
    return A.clearSearchArea(userId, { because, onlyPlace: place }, A.realSetAreaDeps());
  },
  dropTopic: async (userId, topic, ruleId) => { const T = await import("./prefTopics.js"); return T.dropTopicWork(userId, topic, T.realDropDeps, ruleId); },
};
let effectsForTests: Partial<RuleEffects> | null = null;
export function setRuleEffectsForTests(e: Partial<RuleEffects> | null): void {
  effectsForTests = e;
}

// What this turn's stored changes do beyond the record. ch.add[i] is stored.added[i] (storePreferenceChanges keeps the order).
// Their words this message (message) back the place: setSearchArea checks the quote is in it and names the place.
// The decision log carries kinds and outcomes, never their words or the place.
export async function applyRuleEffects(userId: string, ch: PrefChanges, stored: { added: string[]; retired: string[] }, o: { message: string; onFile: Preference[] }): Promise<{ area: string | null; cleared: boolean; topics: number }> {
  const fx: RuleEffects = { ...realEffects, ...(effectsForTests ?? {}) };
  const out = { area: null as string | null, cleared: false, topics: 0 };
  const added = ch.add.map((p, i) => ({ p, id: stored.added[i] })).filter((x) => !!x.id);
  // A withdrawn where-to-search rule takes its area back to home (only while the area is still its place); a new one below sets it again.
  for (const r of ch.retire) {
    if (r.state !== "withdrawn" || !stored.retired.includes(r.id)) continue;
    const was = o.onFile.find((p) => p.id === r.id);
    if (was && areaRuleAppliable(was) && was.areaPlace && !added.some((x) => areaRuleAppliable(x.p))) out.cleared = (await fx.clearArea(userId, was.areaPlace, "the rule that set their search area was withdrawn")) || out.cleared;
  }
  // The newest where-to-search rule for everything is their area (a correction, "SF, not Sacramento", is merged into one rule first).
  const area = [...added].reverse().find((x) => areaRuleAppliable(x.p));
  if (area) {
    // The area before the rule: when it already was this place, the rule didn't set it, so it isn't linked (its withdrawal or end
    // never resets an area set before it).
    const before = await (await import("./searchArea.js")).searchAreaOf(userId).catch(() => null);
    const r = await fx.setArea(userId, { place: area.p.rule.place!, theirWords: area.p.words[area.p.words.length - 1] ?? "", message: o.message });
    out.area = r.ok ? "set" : "ask" in r ? "ambiguous" : "not_set";
    if (r.ok && r.changed === "set" && !(before && areaIsRulePlace(before.place, r.place))) await linkAreaPlace(pool, userId, area.id, r.place);
  }
  for (const x of added) {
    if (x.p.area !== "avoid_topic" || x.p.basis !== "explicit" || !x.p.rule.topic) continue;
    await fx.dropTopic(userId, x.p.rule.topic, x.id);
    out.topics++;
  }
  if (out.area || out.cleared || out.topics) await recordDecision({ layer: 4, decision: "member.preference.applied", userId, outcome: "act", action: out.area ?? (out.cleared ? "area_cleared" : "topic"), proposal: { ids: added.map((x) => x.id), area: out.area, cleared: out.cleared, topics: out.topics } }).catch(() => {});
  return out;
}

// The exact place their area was set to for a rule (see Preference.areaPlace).
export async function linkAreaPlace(db: Db, userId: string, id: string, place: string): Promise<void> {
  await db.query(`UPDATE co_facts SET meta = meta || jsonb_build_object('areaPlace', $3::text) WHERE id = $1 AND owner_user_id = $2 AND relation = '${PREF_RELATION}' AND retired_at IS NULL`, [id, userId, place]);
}

// Their search area changed through the setSearchArea tool (agent/conversationTools.ts), not a rule: the rule and the area never
// disagree. A where-to-search rule naming the place it's now set to is linked to it ("Springfield" once they said "the Missouri one");
// every other one is superseded by the change (or, set back home, withdrawn), as a change in what-Cue-knows does (retireAreaRules).
export async function syncAreaRules(userId: string, now: { place: string } | null, db: Db = pool, at: Date = new Date()): Promise<{ linked: number; retired: number }> {
  let linked = 0;
  let retired = 0;
  for (const p of (await loadPreferences(userId, db)).filter((x) => areaRuleAppliable(x))) {
    // A time-bound rule is never linked to an area the tool set for good: its end would reset that area. It's superseded instead.
    if (now && !p.expiresAt && areaIsRulePlace(now.place, p.rule.place!)) {
      if (p.areaPlace !== now.place) await linkAreaPlace(db, userId, p.id, now.place);
      linked++;
      continue;
    }
    const u = await db.query(`UPDATE co_facts SET retired_at = $3, meta = meta || jsonb_build_object('state', $4::text) WHERE id = $1 AND owner_user_id = $2 AND relation = '${PREF_RELATION}' AND retired_at IS NULL`, [p.id, userId, at, now ? "superseded" : "withdrawn"]);
    if (u.rowCount) retired++;
  }
  if (linked || retired) await recordDecision({ layer: 4, decision: "member.preference.area_sync", userId, outcome: "act", action: now ? "set" : "home", proposal: { linked, retired } }).catch(() => {});
  return { linked, retired };
}

// A time-bound where-to-search rule ("only SF this week") ends at its expiry: retired as expired, and their area set back to home if
// it's still that rule's place (an area set since by anything else stays). Never announced (a quiet-hours or no-text rule may be in
// force; the next reply's facts simply no longer carry it). jobs/index.ts runs it every 10 minutes; userId: one member's only.
export async function expireAreaRules(o: { now?: Date; userId?: string; clear?: (userId: string, place: string) => Promise<boolean> } = {}, db: Db = pool): Promise<{ expired: number; cleared: number }> {
  const at = o.now ?? new Date();
  const { rows } = await db.query(
    `SELECT id, owner_user_id, object_label, happened_at, retired_at, meta FROM co_facts
     WHERE relation = '${PREF_RELATION}' AND subject = 'member' AND retired_at IS NULL AND meta->>'area' = 'search_area'
       AND meta->>'expiresAt' IS NOT NULL AND (meta->>'expiresAt')::timestamptz <= $1 AND ($2::uuid IS NULL OR owner_user_id = $2::uuid)
     LIMIT 200`,
    [at, o.userId ?? null],
  );
  const clear = o.clear ?? (async (userId: string, place: string) => {
    const A = await import("./searchArea.js");
    return A.clearSearchArea(userId, { because: "the time they gave for searching there ended", onlyPlace: place }, A.realSetAreaDeps());
  });
  let expired = 0;
  let cleared = 0;
  for (const r of rows) {
    const p = rowToPref(r);
    if (!p || inForce({ ...p, state: "active" }, at)) continue;
    const userId = String(r.owner_user_id);
    const u = await db.query(`UPDATE co_facts SET retired_at = $3, meta = meta || '{"state":"expired"}'::jsonb WHERE id = $1 AND owner_user_id = $2 AND relation = '${PREF_RELATION}' AND retired_at IS NULL`, [p.id, userId, at]);
    if (!u.rowCount) continue;
    expired++;
    // Only an area this rule set (linked): one set before it or since stays.
    if (areaRuleAppliable(p) && p.areaPlace && (await clear(userId, p.areaPlace).catch(() => false))) cleared++;
  }
  if (expired) await recordDecision({ layer: 4, decision: "member.preference.expired", userId: o.userId ?? null, outcome: "act", action: "area", proposal: { expired, cleared } }).catch(() => {});
  return { expired, cleared };
}

// A where-to-search rule whose area couldn't be set because a place lookup (or the save) was down is tried again, bounded (2026-11-11:
// Royce's "switch the search to San Francisco" on 11-04 hit a geocoder outage, was never retried, and his searches stayed in
// Sacramento). jobs/index.ts runs it every 10 minutes with expireAreaRules. Only a standing, said-outright rule with no area linked, set
// in the last AREA_RETRY.withinDays, while no other area is set; at most AREA_RETRY.tries tries, AREA_RETRY.spacingMin apart. A place
// that doesn't exist or could be more than one is never retried (the reply already said so or asked). After the last try it's given up
// and the next reply tells them once (replyPreferenceFacts). Nothing is sent from here.
// Model-facing (Royce approves the wording): the one line after the retries gave up.
export const AREA_GAVE_UP_LINE = (place: string) => `Their searches did not switch to ${place}: where ${place} is couldn't be checked, even after trying again over a few hours, so Cue still searches where it did before. Tell them that once, plainly, in a line inside this reply, and that saying it again will set it. Don't apologize at length or explain the lookup.`;
export const AREA_RETRY = { tries: 4, spacingMin: 60, withinDays: 7, settleMin: 5 };
// Pure: a lookup or save that was down, worth another try (searchArea.ts setSearchArea's errors).
export const areaErrorTransient = (error: string): boolean => /couldn't be checked just now|couldn't be saved just now/.test(error);
// Pure: whether this rule is due another try now.
export function areaRetryDue(p: Preference, now: Date, areaSet: boolean): boolean {
  if (areaSet || p.state !== "active" || !areaRuleAppliable(p) || p.areaPlace || p.basis !== "explicit") return false;
  const r = p.areaRetry ?? { tries: 0, lastAt: null, gaveUp: false, toldAt: null };
  if (r.gaveUp || r.tries >= AREA_RETRY.tries) return false;
  const age = now.getTime() - Date.parse(p.setAt);
  if (age < AREA_RETRY.settleMin * 60_000 || age > AREA_RETRY.withinDays * 86_400_000) return false;
  return !r.lastAt || now.getTime() - Date.parse(r.lastAt) >= AREA_RETRY.spacingMin * 60_000;
}
export async function retryAreaRules(o: { now?: Date; userId?: string } = {}, db: Db = pool): Promise<{ tried: number; set: number; gaveUp: number }> {
  const at = o.now ?? new Date();
  const fx: RuleEffects = { ...realEffects, ...(effectsForTests ?? {}) };
  const { rows } = await db.query(
    `SELECT DISTINCT owner_user_id FROM co_facts WHERE relation = '${PREF_RELATION}' AND subject = 'member' AND retired_at IS NULL AND meta->>'area' = 'search_area'
       AND meta->>'areaPlace' IS NULL AND COALESCE((meta->'areaRetry'->>'gaveUp')::boolean, false) = false AND happened_at > $1 AND ($2::uuid IS NULL OR owner_user_id = $2::uuid) LIMIT 100`,
    [new Date(at.getTime() - AREA_RETRY.withinDays * 86_400_000), o.userId ?? null],
  );
  const out = { tried: 0, set: 0, gaveUp: 0 };
  for (const row of rows) {
    const userId = String(row.owner_user_id);
    const areaSet = !!(await (await import("./searchArea.js")).searchAreaOf(userId, db).catch(() => ({ place: "unknown" })));
    // The newest due rule only: an older one is superseded by it.
    const p = (await loadPreferences(userId, db)).filter((x) => areaRetryDue(x, at, areaSet)).sort((a, b) => Date.parse(b.setAt) - Date.parse(a.setAt))[0];
    if (!p) continue;
    const words = p.words[p.words.length - 1] ?? "";
    const r = await fx.setArea(userId, { place: p.rule.place!, theirWords: words, message: words }).catch((err: any): { ok: false; error: string } => ({ ok: false, error: `it couldn't be saved just now (${String(err?.message ?? err).slice(0, 80)})` }));
    out.tried++;
    const tries = (p.areaRetry?.tries ?? 0) + 1;
    if (r.ok) {
      if (r.changed === "set") await linkAreaPlace(db, userId, p.id, r.place);
      await db.query(`UPDATE co_facts SET meta = meta - 'areaRetry' WHERE id = $1 AND owner_user_id = $2 AND relation = '${PREF_RELATION}'`, [p.id, userId]);
      out.set++;
      await recordDecision({ layer: 4, decision: "member.preference.area_retry", userId, outcome: "act", action: "set", proposal: { id: p.id, tries } }).catch(() => {});
      continue;
    }
    // Never retried: a place that could be more than one, or one that doesn't exist. Given up at once, said once.
    const gaveUp = !("error" in r) || !areaErrorTransient(r.error) || tries >= AREA_RETRY.tries;
    await db.query(`UPDATE co_facts SET meta = meta || jsonb_build_object('areaRetry', $3::jsonb) WHERE id = $1 AND owner_user_id = $2 AND relation = '${PREF_RELATION}'`, [p.id, userId, JSON.stringify({ tries, lastAt: at.toISOString(), gaveUp, toldAt: "ask" in r ? at.toISOString() : null })]);
    if (gaveUp) out.gaveUp++;
    await recordDecision({ layer: 4, decision: "member.preference.area_retry", userId, outcome: "skip", action: gaveUp ? "gave_up" : "later", reason: "error" in r ? r.error.slice(0, 120) : "ambiguous", proposal: { id: p.id, tries } }).catch(() => {});
  }
  return out;
}

// What-Cue-knows changed their search area itself (corrected or removed there): the where-to-search rules that set it are retired with
// it, their words blanked, so a rule shown as "noted" can't sit beside an area it no longer is, and nothing rebuilds it.
export async function retireAreaRules(db: Db, userId: string, now: Date = new Date()): Promise<number> {
  const r = await db.query(
    `UPDATE co_facts SET retired_at = $2, object_label = '', meta = (meta - 'words') || '{"state":"withdrawn","words":[]}'::jsonb
     WHERE owner_user_id = $1 AND relation = '${PREF_RELATION}' AND retired_at IS NULL AND meta->>'area' = 'search_area' AND COALESCE(meta->'ruleRaw'->>'topic', '') = ''`,
    [userId, now],
  );
  return r.rowCount ?? 0;
}

// ---------------------------------------------------------------- the read before the reply (spec: a rule said in a turn shapes that turn)

// One small read of their own words (never a photo's or file's description, a merged earlier link, or quoted text), before the reply,
// so the reply's facts (replyPreferenceFacts) already hold what they just set and say honestly whether it's applied. Stored through the
// same resolve as everything else. The turn's later learning read doesn't read rules again. Returns the ids it stored.
let prefModelForTests: ((prompt: string) => Promise<string>) | null = null;
export function setPreferenceModelForTests(fn: typeof prefModelForTests): void {
  prefModelForTests = fn;
}
// via "call": their words since the last read on a phone call they're on (services/callPreferences.ts), from speech recognition.
export function preferenceReadPrompt(o: { words: string; onFile: Preference[]; localToday: string; via?: "text" | "call" }): string {
  const opening = o.via === "call"
    ? `Read what a person just said to Cue (an assistant) on a phone call they're on now (from speech recognition, so it can hold small mistakes). Find only standing instructions about how Cue should treat them. "This call" and "now" mean the call they're on.`
    : `Read the last message a person texted Cue (an assistant). Find only standing instructions about how Cue should treat them.`;
  return `${opening}

Their message: "${o.words.slice(0, 1500)}"

${preferencePromptItem({ n: 1, onFile: o.onFile, localToday: o.localToday })}

Return ONLY valid JSON, no preamble: {${PREFERENCE_JSON_SHAPE}}. An empty list when there's none.`;
}
export async function capturePreferencesNow(userId: string, words: string, o: { zone: string | null; source: Preference["source"]; now?: Date; via?: "text" | "call" }): Promise<{ added: string[]; retired: string[] }> {
  const now = o.now ?? new Date();
  const own = ownWords(words).trim();
  if (own.length < 4) return { added: [], retired: [] };
  const onFile = await activePreferences(userId, now);
  const prompt = preferenceReadPrompt({ words: own, onFile, localToday: DateTime.fromJSDate(now).setZone(wordsZone(o.zone)).toISODate()!, via: o.via });
  const text = prefModelForTests
    ? await prefModelForTests(prompt)
    : await (async () => {
        const [{ generateText }, { anthropic }, { MODELS }] = await Promise.all([import("ai"), import("@ai-sdk/anthropic"), import("../models.js")]);
        return (await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 600, abortSignal: AbortSignal.timeout(8000), experimental_telemetry: { isEnabled: true, functionId: "preferences.read", recordInputs: false, recordOutputs: false }, prompt })).text;
      })();
  const { parseModelJson } = await import("./modelJson.js");
  // An answer that can't be read is a failed read (it throws): the turn's later learning read takes the rules then, never silently none.
  const parsed = parseModelJson<any>(text);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.preferences)) throw new Error("preferences read: no list in the answer");
  return learnPreferences(userId, parsed.preferences, { message: own, zone: o.zone, now, source: o.source, onFile });
}

// ---------------------------------------------------------------- words (member-facing: the PR's Copy section lists every one)

const dayList = (ds: number[]) => {
  const w = ds.map((d) => DAY_WORDS[d]);
  return w.length <= 2 ? w.join(" and ") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
};
const clock = (hm: string) => DateTime.fromFormat(hm, "HH:mm").toFormat("h:mm a").replace(":00", "").toLowerCase();

// ---------------------------------------------------------------- applied, or noted (PR C: say only what a path really does)

// What a rule is held against right now: their search area (services/searchArea.ts searchAreaOf), when the caller read it. Left out,
// a search_area rule is never said to be applied (the honest default: nothing known says it is).
// home: their home city; a rule naming it set searches back to home (searchArea.ts), so it's applied while no area is set.
export type ApplyCtx = { area?: { place: string } | null; home?: string | null };
const placeKey = (t: string) => squash(t.trim().replace(/[.,;:!?]+$/, ""));
// Pure: whether an area place is the place a rule names: the same place by name (aliases too: SF is San Francisco), with no region or
// country of the rule's that the area contradicts. "Springfield, Missouri" is what "Springfield" named once they said which; "Portland,
// OR" is never "Portland, ME". Read from the place's parts (placeResolve.ts), not its raw string.
export function areaIsRulePlace(areaPlace: string, rulePlace: string): boolean {
  const a = parseQualified(areaPlace);
  const r = parseQualified(rulePlace);
  if (!a.name || normName(a.name) !== normName(r.name)) return false;
  return (!r.region || !a.region || r.region === a.region) && (!r.country || !a.country || r.country === a.country);
}
// Pure: the place a rule's search area is (or would be): the exact one it was set to, else what the rule names.
export const rulePlaceOf = (p: Pick<Preference, "rule" | "areaPlace">): string => p.areaPlace || p.rule.place || "";
// Pure: a where-to-search rule that becomes their search area: said outright, standing, for everything with no place of its own (no
// subject of its own), with a place. Time-bound ones too ("only SF this week"): expireAreaRules sets searches back when it ends.
export function areaRuleAppliable(p: Pick<Preference, "area" | "basis" | "type" | "rule">): boolean {
  return p.area === "search_area" && p.basis === "explicit" && p.type === "standing" && !p.rule.topic && !!p.rule.place;
}
// Pure: whether a path applies this rule now. Send rules: the send gate (harness/notifyGate.ts). A search area: only while their area
// really is that place (a lookup that failed, or a place that could be more than one, left it unset). How to reply and what not to bring
// up: their own words only (an inferred read stays tentative: spec, section 2).
export function ruleApplied(p: Pick<Preference, "area" | "basis" | "type" | "rule"> & { areaPlace?: string | null }, ctx: ApplyCtx = {}): boolean {
  if (ENFORCED_AREAS.has(p.area)) return true;
  if (p.area === "reply_style") return p.basis === "explicit" && !!p.rule.style;
  if (p.area === "avoid_topic") return p.basis === "explicit" && !!p.rule.topic;
  if (p.area === "search_area") {
    if (!areaRuleAppliable(p)) return false;
    const linked = (p as Pick<Preference, "areaPlace">).areaPlace;
    if (ctx.area?.place) return linked ? placeKey(ctx.area.place) === placeKey(linked) : areaIsRulePlace(ctx.area.place, p.rule.place!);
    return ctx.area === null && !!ctx.home && areaIsRulePlace(ctx.home, p.rule.place!);
  }
  return false;
}

// Pure: what the rule does, in plain words, for what-Cue-knows. Code-built from the stored structure, so it says what is enforced.
// applied: ruleApplied's answer from the caller (which knows their search area); left out, the area alone decides, and a search area
// is never said to be applied.
export function describePreference(p: Pick<Preference, "area" | "covers" | "channel" | "rule" | "expiresAt" | "zone" | "type" | "basis">, o: { applied?: boolean } = {}): string {
  const r = p.rule;
  const what = p.area === "checkins" || p.covers === "checkins" ? "check-ins" : p.covers === "all" ? (p.channel === "call" ? "calls from me" : p.channel === "text" ? "texts from me" : "messages from me") : p.channel === "call" ? "calls I start" : "messages I start";
  const parts: string[] = [];
  if (r.none) parts.push(`no ${what}`);
  if (r.maxPerDay !== undefined) parts.push(`at most ${r.maxPerDay === 1 ? "one" : r.maxPerDay} ${what} a day`);
  if (r.maxPerWeek !== undefined) parts.push(`at most ${r.maxPerWeek === 1 ? "one" : r.maxPerWeek} ${what} a week`);
  if (r.noDays) parts.push(`no ${what} on ${dayList(r.noDays)}`);
  if (r.onlyDays) parts.push(`${what} only on ${dayList(r.onlyDays)}`);
  if (r.earliest) parts.push(`nothing before ${clock(r.earliest)}`);
  if (r.latest) parts.push(`nothing after ${clock(r.latest)}`);
  if (r.less && !parts.length) parts.push(`fewer ${what} (you haven't said how many yet)`);
  if (r.place) parts.push(`look for things in ${r.place}${r.topic ? ` (for ${r.topic})` : ""}`);
  // Style is followed, not enforced in code: said so ("I'll keep to this"), never as a hard rule.
  if (r.style) parts.push(`replies: ${r.style}${r.topic ? ` (for ${r.topic})` : ""}${p.area === "reply_style" && (o.applied ?? ruleApplied(p)) ? " (I'll keep to this)" : ""}`);
  if (p.area === "avoid_topic" && r.topic) parts.push(`don't bring up ${r.topic} unless you do`);
  if (!parts.length && r.topic) parts.push(r.topic);
  let line = parts.join("; ");
  if (p.expiresAt) line += `, until ${DateTime.fromISO(p.expiresAt).setZone(wordsZone(p.zone)).toFormat("ccc LLL d")}`;
  if (p.type === "one_time") line += " (just this once)";
  if (p.basis === "inferred") line = `my read: ${line}`;
  if (!(o.applied ?? ruleApplied(p))) line += " (noted, not applied yet)";
  return line;
}

// Internal prompt lines (not member copy): what each decision-area rule does when applied, and what Cue offers instead when it isn't.
function appliedLine(p: Preference, applied: boolean): string {
  if (ENFORCED_AREAS.has(p.area)) return applied ? "Cue's sends enforce it in code; replies to their texts always go." : "";
  if (applied) {
    if (p.area === "search_area") return "Applied: their search area is set to this, so every ask, goal and daily search that names no place of its own looks there; asks and goals that name a place keep it, and their home city didn't change.";
    if (p.area === "reply_style") return "Cue follows it in its replies and on calls where it applies (an instruction Cue keeps, not a hard rule in code).";
    return "Applied: Cue drops suggestions and check-ins about it, and doesn't raise it unless they do.";
  }
  if (p.basis === "inferred") return "Cue's tentative read, not applied: never act as if they said it. If it matters now, ask them once.";
  if (p.area === "search_area") {
    if (p.type === "one_time") return "Just this once, not a standing change: search there for what they asked now; never say their searches moved.";
    if (p.rule.topic) return "Not applied: where Cue searches is set for everything at once, not one subject. Never say it's applied. Offer what Cue can do: put that place on the one ask or goal it's for, or search there for everything from now on.";
    return "Not applied: where Cue searches didn't change to this (the place couldn't be settled on the map, or it could mean more than one place). Never say it changed. Say plainly it didn't, and ask which place they mean if it could be more than one.";
  }
  return "No path applies this: never say it's applied. Say plainly Cue noted it and can't do that yet, and offer the closest thing Cue can do: how often or when it reaches out, check-ins, where it searches, how it replies, or a subject it won't bring up.";
}

// The rules the reply check reads (services/prefTopics.ts judgeReplyRules): how to reply, by subject, and what not to bring up.
export type ReplyRules = { style: { id?: string; style: string; topic: string | null; words: string }[]; avoid: string[] };

// Facts for the reply (harness/replyGrounding.ts) and the call (services/callContext.ts callFitLines): what's in force and what it's
// applied to, so a reply never says a rule is applied when its path ignores it, and the one ask for a vague "less". Internal prompt
// lines, not member copy. ids: the vague rules this reply is told to ask about (marked asked once the reply goes).
// ctx: their search area, when the caller read it (left out, a search area rule is never said to be applied).
export function replyPreferenceFacts(prefs: Preference[], now: Date, ctx: ApplyCtx = {}): { known: string[]; instructions: string[]; askIds: string[]; rules: ReplyRules; appliedNow: Preference[]; areaNoticeIds: string[] } {
  const live = prefs.filter((p) => inForce(p, now));
  const known: string[] = [];
  const instructions: string[] = [];
  const askIds: string[] = [];
  const rules: ReplyRules = { style: [], avoid: [] };
  const appliedNow: Preference[] = [];
  const areaNoticeIds: string[] = [];
  for (const p of live) {
    const applied = ruleApplied(p, ctx);
    // A search area given up on after its retries (retryAreaRules): said once, plainly, in the next reply that goes (confirmLessAsked).
    if (!applied && p.area === "search_area" && p.areaRetry?.gaveUp && !p.areaRetry.toldAt && p.rule.place) {
      instructions.push(AREA_GAVE_UP_LINE(p.rule.place));
      areaNoticeIds.push(p.id);
    }
    const justNow = now.getTime() - Date.parse(p.setAt) < 5 * 60_000;
    // A decision rule set in this message and applied: the change it made is this turn's (the reply check's change claims stand on it).
    if (applied && justNow && DECISION_AREAS.has(p.area)) appliedNow.push(p);
    const kind = p.type === "one_time" ? "A one-time request" : "A standing rule";
    known.push(`${kind} they ${justNow ? "set in this message" : "set"}${p.basis === "inferred" ? " (Cue's tentative read, not confirmed)" : ""}: ${describePreference(p, { applied })}. ${appliedLine(p, applied)}`.trim());
    if (p.rule.less && p.rule.maxPerDay === undefined && p.rule.maxPerWeek === undefined && !p.askedAt) askIds.push(p.id);
    if (!applied) continue;
    const words = p.words[p.words.length - 1] ?? "";
    if (p.area === "reply_style" && p.rule.style) {
      rules.style.push({ id: p.id, style: p.rule.style, topic: p.rule.topic ?? null, words });
      instructions.push(
        p.rule.topic
          ? `How they asked you to reply when the subject is ${p.rule.topic}: ${p.rule.style} (their words: "${words.slice(0, 200)}"). It applies only to that subject; other replies stay as they'd be.`
          : `How they asked you to reply: ${p.rule.style} (their words: "${words.slice(0, 200)}"). It applies to every reply, except where a rule for a specific subject says otherwise.`,
      );
    }
    if (p.area === "avoid_topic" && p.rule.topic) {
      rules.avoid.push(p.rule.topic);
      instructions.push(`They asked you not to bring up ${p.rule.topic} (their words: "${words.slice(0, 200)}"). Don't raise it, suggest anything about it, or ask about it. If they bring it up themselves, follow their lead on it.`);
    }
  }
  if (rules.style.some((r) => r.topic) && rules.style.some((r) => !r.topic)) instructions.push("When a reply is about a subject that has its own reply rule, that rule wins over the general one.");
  if (askIds.length) instructions.push("They asked Cue to reach out less without saying how often. Ask once, in a few words, how often works for them. Never suggest a number yourself.");
  if (live.length) instructions.push("A preference never lets Cue spend money, share anyone's details, give access or act as them. If they ask for that through a preference, say plainly Cue can't take it that way.");
  return { known, instructions, askIds, rules, appliedNow, areaNoticeIds };
}
