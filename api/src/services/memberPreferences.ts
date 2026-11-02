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
// Where PR C plugs in (enforcement in decisions, not just sends): a rule with area "search_area" (services/sweepFind.ts and
// goalSweep.ts read activePreferences for the place), "reply_style" (the reply's facts and check), and "other". Until then they are
// stored, shown with "not applied yet", and the reply is told so (replyPreferenceFacts), so Cue never says one is applied when the
// path ignores it. ENFORCED_AREAS is the one list to widen as each path starts reading them.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { wordsZone } from "./memberTime.js";

export type PrefArea = "contact" | "checkins" | "search_area" | "reply_style" | "other";
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
};

export const PREF_AREAS: readonly PrefArea[] = ["contact", "checkins", "search_area", "reply_style", "other"];
// The areas some path enforces today. PR C widens it as searches, replies and calls start reading their rules.
export const ENFORCED_AREAS: ReadonlySet<PrefArea> = new Set<PrefArea>(["contact", "checkins"]);

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
  - area: "contact" (texts or calls Cue sends them), "checkins" (only check-ins), "search_area" (where to look for events or things; rule.place), "reply_style" (how to reply; rule.style and, if it's for a subject, rule.topic), "other" (rule.topic says what).
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
export function quoteIsTheirs(quote: string, message: string): boolean {
  const q = squash(quote);
  if (q.length < 4 || !squash(message).includes(q)) return false;
  const outside = message.replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/g, " ");
  return squash(outside).includes(q);
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
    out.push({ type, area, covers, channel, basis: p.basis === "inferred" ? "inferred" : "explicit", rule: ruleFrom(p.rule), expiresOn, replaces, quote });
  }
  return out;
}

// ---------------------------------------------------------------- resolving a read against what's on file

export type NewPref = Omit<Preference, "id" | "state" | "setAt" | "askedAt">;
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
const sameScope = (a: Pick<Preference, "area" | "covers" | "channel" | "type">, b: Pick<Preference, "area" | "covers" | "channel" | "type">) =>
  a.area === b.area && a.covers === b.covers && a.channel === b.channel && a.type === b.type;

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
    const scope = { area: r.area, covers: r.covers, channel: r.channel, type } as const;
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

// Pure: in force now (not retired, started, not past its expiry). Expiry is in their zone, stored as the instant it ends.
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
    rule: ruleFrom(m.ruleRaw ?? {}),
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
export async function withdrawPreference(db: Db, userId: string, id: string, now: Date = new Date()): Promise<boolean> {
  const r = await db.query(
    `UPDATE co_facts SET retired_at = $3, meta = meta || '{"state":"withdrawn"}'::jsonb WHERE id = $1 AND owner_user_id = $2 AND relation = '${PREF_RELATION}' AND retired_at IS NULL`,
    [id, userId, now],
  );
  return !!r.rowCount;
}

// The vague "less": asked once. Marked when the reply that carried the ask goes (the reply facts below hand it the ask).
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
  return storePreferenceChanges(userId, resolveReads(onFile, reads, { now, zone: o.zone, source: o.source }), { now });
}

// ---------------------------------------------------------------- words (member-facing: the PR's Copy section lists every one)

const dayList = (ds: number[]) => {
  const w = ds.map((d) => DAY_WORDS[d]);
  return w.length <= 2 ? w.join(" and ") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
};
const clock = (hm: string) => DateTime.fromFormat(hm, "HH:mm").toFormat("h:mm a").replace(":00", "").toLowerCase();

// Pure: what the rule does, in plain words, for what-Cue-knows. Code-built from the stored structure, so it says what is enforced.
export function describePreference(p: Pick<Preference, "area" | "covers" | "channel" | "rule" | "expiresAt" | "zone" | "type" | "basis">): string {
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
  if (r.place) parts.push(`look for things in ${r.place}`);
  if (r.style) parts.push(`replies: ${r.style}${r.topic ? ` (for ${r.topic})` : ""}`);
  if (!parts.length && r.topic) parts.push(r.topic);
  let line = parts.join("; ");
  if (p.expiresAt) line += `, until ${DateTime.fromISO(p.expiresAt).setZone(wordsZone(p.zone)).toFormat("ccc LLL d")}`;
  if (p.type === "one_time") line += " (just this once)";
  if (p.basis === "inferred") line = `my read: ${line}`;
  if (!ENFORCED_AREAS.has(p.area)) line += " (noted, not applied yet)";
  return line;
}

// Facts for the reply (harness/replyGrounding.ts): what's in force and what it's applied to, so a reply never says a rule is applied
// when its path ignores it, and the one ask for a vague "less". Internal prompt lines, not member copy. ids: the vague rules this reply
// is told to ask about (marked asked once the reply goes).
export function replyPreferenceFacts(prefs: Preference[], now: Date): { known: string[]; instructions: string[]; askIds: string[] } {
  const live = prefs.filter((p) => inForce(p, now));
  const known: string[] = [];
  const instructions: string[] = [];
  const askIds: string[] = [];
  for (const p of live) {
    const applied = ENFORCED_AREAS.has(p.area);
    known.push(`A standing rule they set${p.basis === "inferred" ? " (Cue's tentative read, not confirmed)" : ""}: ${describePreference(p)}. ${applied ? "Cue's sends enforce it in code; replies to their texts always go." : "No path applies this yet: never say it's applied; say plainly Cue noted it and can't apply it yet."}`);
    if (p.rule.less && p.rule.maxPerDay === undefined && p.rule.maxPerWeek === undefined && !p.askedAt) askIds.push(p.id);
  }
  if (askIds.length) instructions.push("They asked Cue to reach out less without saying how often. Ask once, in a few words, how often works for them. Never suggest a number yourself.");
  if (live.length) instructions.push("A preference never lets Cue spend money, share anyone's details, give access or act as them. If they ask for that through a preference, say plainly Cue can't take it that way.");
  return { known, instructions, askIds };
}
