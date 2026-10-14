// What the sweep surfaces, chosen by Co (Royce, 2026-10-02): functions gather
// candidates, dedupe them and hold the hard rails (caps, safety, never the
// same thing twice); the model, given the member's whole context and the
// pool, decides what goes out. It has to say why THIS member and why NOW; if
// it can't, nothing sends. The bar is "they'd reply wow", not "seems
// relevant". Every candidate gets a verdict and a reason, so the judgment can
// be audited, not just counted.
//
// Not wired into the live sweep yet: evals/sweepSelect/replay.ts runs it on a
// member's past sweeps for blind grading, then a shadow week, then Royce
// decides the switch.
//
// One call per member per day across all their asks. Answers (things they
// asked for) clear the same bar as discovery; they only skip the quota.
// Code checks facts, never intent: cited records exist, dates aren't past,
// a send says why-member, why-now and wow, and a reject that says something
// is closed or already known cites a record about that very find (checked by
// code where it can be, by one batched Haiku read where it can't).
import { createHash } from "crypto";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS } from "../models.js";
import Anthropic from "@anthropic-ai/sdk";
import { parseModelJson } from "./modelJson.js";

export const SELECT_MODEL = MODELS.sonnet;
export const SELECT_LIMITS = { maxPool: 40, maxSends: 3, texts: 40, sent: 20 };

export type PoolItem = {
  id: string; // C1, C2... within one run
  key: string; // stable identity across runs (normalized name + date)
  name: string;
  date: string | null; // YYYY-MM-DD, local
  tier: number;
  kind: "answer" | "discovery";
  asks: string[]; // A# ids it serves (empty for profile finds)
  shortNotice?: boolean;
  details?: string | null; // facts from its page, when known
};

export type SelectContext = {
  firstName: string;
  city: string | null;
  today: string; // YYYY-MM-DD local
  weekday: string;
  zone?: string; // their zone (every stamp below is in it)
  goals?: string[]; // where they are headed (every active goal, newest first): the lens, judged against alongside the asks, never recited
  goalsTrimmed?: number; // active goals over the safety ceiling, left out of `goals` (logged; never a silent cut)
  goalsPast?: PastGoal[]; // G#: goals done, set aside or lapsed: history, never the lens (a replaced goal isn't listed, #188)
  asks: { id: string; text: string; since: string; closed?: boolean }[]; // A#
  texts: { id: string; at: string; from: "member" | "co"; text: string }[]; // T#
  sent: { id: string; at: string; what: string; reaction: string | null }[]; // S#
  // O#. closes: they declined it, or said themselves that they did it (a stated result), so it can carry an "already known" reject.
  outcomes: { id: string; at: string; item: string; result: string; note: string | null; closes?: boolean }[];
  feeling: string | null;
  // From the shared member layer (services/memberKnowledge.ts), live runs only: what Co already gave them, what it is carrying,
  // what it has learned (corrections, lessons, taste), its read of them, and the member-level rules (memberRules).
  delivered?: { id: string; what: string; kind: string; at: string; reaction: string | null }[]; // D#
  carrying?: string[];
  learned?: string[];
  person?: string | null;
  rules?: string[];
  // What kind of room they've told Co they want or don't (services/roomTaste.ts), newest first: candidates are ranked by it.
  roomTaste?: string[];
  discoveryLeft: number; // discovery sends left this week
  pool: PoolItem[];
  // The 9am floor's run (services/dailySweep.ts): one find per tier goes out (tierPicks), and the prompt says so.
  morning?: boolean;
};

// A goal that's no longer the lens, and why (G#). done and set_aside are the member's own word (they closed it, or said so); lapsed is
// Co's bookkeeping (its window passed, no answer to a recheck, or nothing on file says who closed it) and never carries a closed claim.
// A goal replaced by a newer one isn't listed at all: its aim goes on in the newer goal (#188).
export type PastGoal = { id: string; text: string; state: "done" | "set_aside" | "lapsed"; why?: string | null };

// How a candidate fits the room they've said they want: ranks sends within their kind (slotOrder). "neutral" when nothing was said.
export type TasteFit = "matches" | "neutral" | "clashes";
// rank and forThem: on the morning run, the candidate's place within its own tier (1 = the one to send from it) and one line on what it
// offers them, used when it is the one that goes from its tier whatever its verdict (tierPicks).
type MorningRead = { rank?: number | null; forThem?: string | null };
export type Verdict =
  | ({ id: string; verdict: "send"; whyMember: string; cites: string[]; whyNow: string; wow: boolean; lastDay: string | null; taste?: TasteFit } & MorningRead)
  | ({ id: string; verdict: "hold"; why: string; until: string | null } & MorningRead)
  | ({ id: string; verdict: "reject"; reason: RejectReason; why: string; cites: string[] } & MorningRead);

// closed: it rests on something finished (a closed ask, a past goal done or set aside). already_known: they mentioned it, are going,
// already have it, or said no. Both are claims about a record, so both must cite it (RECORD_CLAIMS, checked in guardVerdicts); the
// rest are judgment and need no cite.
// ruled_out: their own words (an ask or a text of theirs) rule out this thing or this kind of thing (Royce, 2026-10-14: "not giant
// mixers" against a large community); a claim about their words, so it cites them and the claim check reads them against the find.
export const REJECT_REASONS = ["not_them", "weak_fit", "too_late", "covered", "closed", "already_known", "ruled_out", "other"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
export const RECORD_CLAIMS: readonly RejectReason[] = ["closed", "already_known", "ruled_out"];

// The part that's the same for every member: cached across a sweep batch.
export const SELECT_SYSTEM = `You're Co. You know this member well. A search already gathered a pool of things that might be worth texting them about. Your job is to decide, for each one, whether it goes out today.

The bar is: they'd reply "wow". Not "seems relevant", not "fits a keyword in their ask". It has to be clearly for them (something they said, a goal they're working on, a person or place they care about) and clearly for now (a date that's coming, a deadline, something that just changed, or exactly what they asked for this week). If you can't say both, it doesn't go today.

For every candidate, give one verdict:
- "send": it clears the bar today. Say why this member, citing the records it rests on by id (A# their asks, T# texts, S# what Co sent before, O# how they reacted), why now, and "wow": true only if you'd genuinely expect that reaction. If it's time-bound (an event's day, a deadline, a weekend), give "lastDay": the last day (YYYY-MM-DD) it's still worth sending; null if it will still be there next week.
- "hold": good for them, but the thing itself isn't ready yet (it opens later, or it's too far out to act on), or it would crowd a stronger send today. Say when it would be right, as a date (YYYY-MM-DD) if you can. You judge whether it fits them and its timing, never their attention: don't hold something because they seem busy, focused elsewhere or in a mood. They decide what they're too busy for. Something open now with a deadline, or applications open, is never held for that.
- "reject": not for them. Give a reason code: not_them (doesn't match who they are), weak_fit (only loosely related), too_late (passed or too short notice to act on), covered (another candidate in today's pool does the same job better; cite its C# in "cites"), closed (it rests on something finished: an ask that's closed, or a past goal that's done or set aside), already_known (they mentioned it, are going, already have it, or said no), ruled_out (their own words rule out this thing or this kind of thing; cite the ask or text, A# or T#, where they said it), other. Add one line why.

A ruled_out reject cites their own words (A# or T#) that rule it out. A closed or already_known reject is a claim about a record, so it cites that record by id in "cites": a closed ask (A#), a past goal that's done or set aside (G#), something Co sent or they already have (S#, D#), their own text (T#), or how they reacted (O#: they declined it, or did it). The record has to be about this candidate itself: they mentioned this very thing, already have it, are going, said no to it, or finished it. A closed ask or a finished goal about a different program doesn't close this one, even when it's the same kind of thing, and never while one of their active goals still carries the aim. If you can't point to such a record, it isn't closed or known: judge the candidate on fit instead. Don't call something closed, done, set aside, finished or already known under any other code; use closed or already_known and cite it. A reject that claims a record without citing one about this candidate isn't applied: the candidate stays and comes back to you.

Past goals each say why they're past. done and set aside are their word. lapsed is Co's own bookkeeping (a window that passed, a recheck they didn't answer), not theirs, and is never the reason something is closed. A closed one-off question (find me a couple of these) doesn't close an aim one of their active goals still carries either.

An ask isn't finished after one send: someone looking for events this week usually wants a few across the week, and a search for a community can take several tries. What Co already sent for an ask only counts against a candidate when it's the same kind of thing for the same moment. "covered" means another candidate in today's pool does the same job better, not that the ask got something before.

Some candidates come with only a name and a date. Judge what the name tells you; thin isn't the same as weak.

Things they asked for and things you'd bring up yourself clear the same bar. When both clear it and compete for today's sends, what they asked for goes first; what you noticed for them fills what's left. Send at most ${SELECT_LIMITS.maxSends}, the strongest first; usually one or none. Sending nothing today is a good answer when nothing clears the bar. Use only what's in the records; never assume something they didn't say.

When you send more than one, add "set": one line on why these go together today (what they share for this member, or how they differ), in plain words; it's what Co's message opens with. Leave it out for one send or none.

Return ONLY JSON:
{"set":"...","verdicts":[{"id":"C1","verdict":"send","whyMember":"...","cites":["A2","T5"],"whyNow":"...","wow":true,"lastDay":"2026-10-08","taste":"matches"},{"id":"C2","verdict":"hold","why":"...","until":"2026-10-08"},{"id":"C3","verdict":"reject","reason":"weak_fit","why":"..."},{"id":"C4","verdict":"reject","reason":"already_known","cites":["S3"],"why":"..."}]}`;

// The morning run's own instructions (member prompt, so SELECT_SYSTEM stays the same for every run and keeps its cache).
export const MORNING_NOTE = `THIS IS THEIR MORNING SEND. One find from each kind goes out this morning: a Co event, an event, an opening (program, place or opportunity), whichever kinds have candidates. Your verdicts still say what you think of each. Also give every candidate "rank": its place among the candidates of its own kind (1 = the one you'd send from that kind), ranked by fit and the room they want, what they asked for first; and "forThem": one plain line on what it offers them, used if it's the one that goes from its kind. A kind's best goes unless something real rules it out: it's over or too late to act on (too_late), they already have it, are going or said no to it (already_known, cited), or their own words rule it out (ruled_out, citing the ask or text). A weak fit or "not a wow" only moves it down its kind; it never empties a kind.`;

// What the thing is, not a rank: tier numbers read as a quality score (the
// 2026-10-02 replay rejected things for being "tier 3").
const SOURCE_LABEL: Record<number, string> = { 1: "a Co event", 2: "an event", 3: "an opening (program, place or opportunity)" };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Pure: why a past goal is past, as the picker reads it.
export function pastWhy(g: PastGoal): string {
  if (g.state === "done") return "done";
  if (g.state === "set_aside") return "set aside";
  return `lapsed${g.why ? `: ${clip(g.why, 100)}` : ""}; Co's bookkeeping, not their word`;
}

// Pure: the member part of the prompt.
export function selectPrompt(c: SelectContext): string {
  const lines: string[] = [];
  lines.push(`Member: ${c.firstName}${c.city ? `, ${c.city}` : ""}. Today: ${c.weekday} ${c.today}${c.zone ? ` (their time, ${c.zone})` : ""}.`);
  lines.push(`Discovery texts left this week: ${c.discoveryLeft} (things they asked for don't use these).`);
  if (c.feeling) lines.push(`How they've been: ${c.feeling}`);
  lines.push(`\nWhat they've asked Co for (open):`);
  lines.push(c.asks.length ? c.asks.map((a) => `${a.id} (since ${a.since}${a.closed ? ", closed since" : ""}): ${clip(a.text, 220)}`).join("\n") : "(none)");
  if (c.goals?.length) lines.push("", "Where they say they are headed (the LENS: judge every candidate against this as well as the asks; never cite it as the reason, the reason is an ask, a text, or what they did):", c.goals.map((g) => `- ${clip(g, 200)}`).join("\n"));
  if (c.goalsPast?.length) lines.push("", "Past goals (history, NOT the lens: never pick something only for a done or set-aside one):", c.goalsPast.map((g) => `${g.id} ${clip(g.text, 200)} (${pastWhy(g)})`).join("\n"));
  if (c.person) lines.push("", "Co's read of them:", clip(c.person, 1500));
  if (c.learned?.length) lines.push("", "What Co has learned about them (a correction replaces what it corrects):", c.learned.map((l) => `- ${clip(l, 200)}`).join("\n"));
  if (c.delivered?.length) lines.push("", "What they already have from Co (never pick the same thing again as news; a reminder of something they're going to is different):", c.delivered.map((d) => `${d.id} ${clip(d.what, 120)} (${d.kind}, ${d.at})${d.reaction ? ` → ${d.reaction}` : ""}`).join("\n"));
  if (c.carrying?.length) lines.push("", "What Co is already working on for them (a candidate that only repeats one of these isn't new):", c.carrying.map((x) => `- ${clip(x, 160)}`).join("\n"));
  lines.push(`\nTheir recent texts with Co (oldest first):`);
  lines.push(c.texts.length ? c.texts.slice(-SELECT_LIMITS.texts).map((t) => `${t.id} ${t.at} ${t.from === "member" ? "They" : "Co"}: ${clip(t.text, 280)}`).join("\n") : "(none)");
  lines.push(`\nWhat Co sent them first, last 30 days, and what happened:`);
  lines.push(c.sent.length ? c.sent.slice(-SELECT_LIMITS.sent).map((s) => `${s.id} ${s.at}: ${clip(s.what, 160)}${s.reaction ? ` → ${s.reaction}` : " → no reply"}`).join("\n") : "(nothing)");
  if (c.outcomes.length) {
    lines.push(`\nHow they've reacted to things Co suggested:`);
    lines.push(c.outcomes.map((o) => `${o.id} ${o.at}: ${clip(o.item, 100)} → ${o.result}${o.note ? ` ("${clip(o.note, 120)}")` : ""}`).join("\n"));
  }
  if (c.rules?.length) lines.push("", "Member rules (for judging what goes; the send step still holds timing and caps):", c.rules.join("\n"));
  if (c.roomTaste?.length) lines.push("", "WHAT KIND OF ROOM THEY'VE TOLD CO THEY WANT (their own words, newest first; the strongest signal you have about fit). Rank by it: give every candidate a taste of \"matches\", \"neutral\" or \"clashes\". One that matches goes up; one that clashes goes down and needs a strong reason to send at all:", c.roomTaste.map((t) => `- ${clip(t, 300)}`).join("\n"));
  if (c.morning) lines.push("", MORNING_NOTE);
  lines.push(`\nThe pool (${c.pool.length}):`);
  lines.push(
    c.pool
      .slice(0, SELECT_LIMITS.maxPool)
      .map((p) => `${p.id} ${p.name}${p.date ? ` (${p.date})` : ""}; ${SOURCE_LABEL[p.tier] ?? "found"}; ${p.kind === "answer" ? `answers ${p.asks.join(", ")}` : "from what they've shared"}${p.shortNotice ? "; short notice" : ""}${p.details ? `; ${clip(p.details, 200)}` : ""}`)
      .join("\n"),
  );
  return lines.join("\n");
}

// Pure: every top-level {...} block in the text, braces inside strings ignored.
export function jsonBlocks(text: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"' && depth > 0) inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) out.push(text.slice(start, i + 1));
    }
  }
  return out;
}

// Pure: the model's verdicts: the first block that parses and has a verdicts
// list, so a note before or after it (even one with braces) can't lose the
// day (review of #57: a greedy match did).
export function tasteFitOf(x: unknown): TasteFit {
  return x === "matches" || x === "clashes" ? x : "neutral";
}
// Pure: the pick's "set" line, when it gave one.
export function parseSet(text: string): string | null {
  for (let at = text.indexOf("{"); at !== -1; at = text.indexOf("{", at + 1)) {
    for (const block of jsonBlocks(text.slice(at))) {
      try {
        const parsed = JSON.parse(block);
        if (Array.isArray(parsed?.verdicts)) return typeof parsed.set === "string" && parsed.set.trim() ? parsed.set.trim().slice(0, 300) : null;
      } catch {}
    }
  }
  return null;
}

export function parseVerdicts(text: string): Verdict[] | null {
  // From each opening brace in turn, so a stray "{" before the JSON (which
  // never closes) can't hide it.
  let j: any = null;
  for (let at = text.indexOf("{"); at !== -1 && !j; at = text.indexOf("{", at + 1)) {
    for (const block of jsonBlocks(text.slice(at))) {
      try {
        const parsed = JSON.parse(block);
        if (Array.isArray(parsed?.verdicts)) {
          j = parsed;
          break;
        }
      } catch {}
    }
  }
  if (!j) return null;
  const out: Verdict[] = [];
  for (const v of j.verdicts) {
    const id = String(v?.id ?? "");
    if (!id) continue;
    const mr: MorningRead = { ...(Number.isFinite(Number(v.rank)) && Number(v.rank) > 0 ? { rank: Number(v.rank) } : {}), ...(typeof v.forThem === "string" && v.forThem.trim() ? { forThem: v.forThem.trim().slice(0, 300) } : {}) };
    if (v.verdict === "send") out.push({ ...mr, id, verdict: "send", whyMember: String(v.whyMember ?? "").trim(), cites: Array.isArray(v.cites) ? v.cites.map(String) : [], whyNow: String(v.whyNow ?? "").trim(), wow: v.wow === true , lastDay: /^\d{4}-\d{2}-\d{2}$/.test(String(v.lastDay ?? "")) ? String(v.lastDay) : null, taste: tasteFitOf(v.taste) });
    else if (v.verdict === "hold") out.push({ ...mr, id, verdict: "hold", why: String(v.why ?? "").trim(), until: /^\d{4}-\d{2}-\d{2}$/.test(String(v.until ?? "")) ? String(v.until) : null });
    else if (v.verdict === "reject") out.push({ ...mr, id, verdict: "reject", reason: (REJECT_REASONS as readonly string[]).includes(v.reason) ? v.reason : "other", why: String(v.why ?? "").trim(), cites: Array.isArray(v.cites) ? v.cites.map(String) : [] });
  }
  return out;
}

// One row per candidate: what was decided and why, including what code changed.
// claimed: the reject code a guarded hold came from (reason "uncited_claim"); guardedRuns: how many runs in a row the same find was
// held that way (carryGuardedRuns).
export type Judgment = { id: string; key: string; name: string; kind: PoolItem["kind"]; verdict: "send" | "hold" | "reject" | "no_verdict"; reason: string; why: string; cites?: string[]; whyNow?: string; until?: string | null; guard?: string; lastDay?: string | null ; taste?: TasteFit; claimed?: RejectReason; guardedRuns?: number; rank?: number; forThem?: string; late?: boolean; tierPick?: number; tierAlternates?: string[]; verified?: boolean; notSentWhy?: string; fitOnlyMornings?: number; checkFailed?: boolean };

// Pure: does a record's text name this find? The same normalized name match the shadow pool uses for what was already sent
// (sweepShadow.ts sentNames), as a whole-word run inside the record.
const normName = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function namesFind(record: string, findName: string): boolean {
  const n = normName(findName);
  return !!n && ` ${normName(record)} `.includes(` ${n} `);
}

// What a record-claim reject's cites rest on. facts: records code can check are about this find (a send, something delivered, or an
// outcome that names it). judge: records only a read can tie to this find (their own text, a closed ask, a goal they closed), checked
// by the claim check (checkClaims). A cite of any other kind exists but carries nothing (an open ask, Co's own text, a lapsed goal).
export type CiteRead = { problem: string } | { facts: string[]; judge: string[] };
export const UNCITED_CLAIM_GUARD = "reject claimed a closed or known record it didn't cite (or cited one that doesn't carry it)";

// Pure: every cite must exist, and at least one must be a record that can be about this find (Royce, 2026-10-14: "a reject claiming
// 'closed' or 'already known' has to cite the actual record or the find survives"; review: the actual record is one about THIS find).
export function checkCites(c: SelectContext, p: Pick<PoolItem, "id" | "name">, cites: string[], known: ReadonlySet<string>, reason?: string): CiteRead {
  if (!cites.length) return { problem: "no record cited" };
  const missing = cites.filter((x) => !known.has(x));
  if (missing.length) return { problem: `cites a record that isn't there (${missing.join(", ")})` };
  // ruled_out rests on their own words: an ask of theirs, or their own text. The claim check reads whether those words rule this out.
  if (reason === "ruled_out") {
    const words = cites.filter((x) => c.asks.some((a) => a.id === x) || c.texts.some((t) => t.id === x && t.from === "member"));
    return words.length ? { facts: [], judge: words } : { problem: `cites none of their own words, an ask or a text of theirs (${cites.join(", ")})` };
  }
  const facts = cites.filter(
    (x) =>
      c.sent.some((s) => s.id === x && namesFind(s.what, p.name)) ||
      (c.delivered ?? []).some((d) => d.id === x && namesFind(d.what, p.name)) ||
      c.outcomes.some((o) => o.id === x && o.closes && namesFind(o.item, p.name)),
  );
  const judge = cites.filter(
    (x) =>
      c.texts.some((t) => t.id === x && t.from === "member") ||
      c.asks.some((a) => a.id === x && a.closed) ||
      (c.goalsPast ?? []).some((g) => g.id === x && g.state !== "lapsed"),
  );
  if (!facts.length && !judge.length) return { problem: `none of its cites is a closed or known record about this find (${cites.join(", ")})` };
  return { facts, judge };
}

// Ids every record in the run carries, for the guard and for the member-safe filter (sweepShadow.ts memberSafeWhy).
export function contextIds(c: SelectContext): Set<string> {
  return new Set([...c.asks.map((a) => a.id), ...c.texts.map((t) => t.id), ...c.sent.map((s) => s.id), ...c.outcomes.map((o) => o.id), ...(c.goalsPast ?? []).map((g) => g.id), ...(c.delivered ?? []).map((d) => d.id), ...c.pool.map((p) => p.id)]);
}

// Pure: which sends get the day's slots first: answers to their asks, then goal finds, each in the model's order.
// Within each kind, what fits the room they've said they want goes first and what clashes with it last (Royce, 2026-10-09: "a member
// telling Co what kind of room they want is the highest-quality signal the picker will ever get").
const TASTE_RANK: Record<TasteFit, number> = { matches: 0, neutral: 1, clashes: 2 };
export function slotOrder(clearing: { at: number; kind: PoolItem["kind"]; taste?: TasteFit }[]): number[] {
  const byTaste = (xs: typeof clearing) => [...xs].sort((a, b) => TASTE_RANK[a.taste ?? "neutral"] - TASTE_RANK[b.taste ?? "neutral"]);
  return [...byTaste(clearing.filter((x) => x.kind === "answer")), ...byTaste(clearing.filter((x) => x.kind !== "answer"))].map((x) => x.at);
}

// Pure: facts only. A send must cite records that exist (at least one of
// theirs: an ask, a text, an outcome; never a past goal), say why-member and why-now, mean wow,
// and not be in the past. A closed or already_known reject must cite a record
// that can be about this find, or it is held instead (checkCites; the read of
// whether it really is about this find is checkClaims, after). A covered reject
// must cite a candidate still in the running. Over the send limit, the rest are held. Asks win
// contested slots (Royce, 2026-10-09: "asks are orders"): what they asked for
// takes the day's sends first, in the model's order, and goal finds fill what's
// left, in the model's order. Anything left without a verdict is logged as such.
export function guardVerdicts(c: SelectContext, verdicts: Verdict[]): Judgment[] {
  const known = contextIds(c);
  // A past goal is never "theirs" for a send: it's history, not something they're asking for now.
  const theirs = new Set([...c.asks.map((a) => a.id), ...c.texts.filter((t) => t.from === "member").map((t) => t.id), ...c.outcomes.map((o) => o.id)]);
  const byId = new Map(c.pool.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: Judgment[] = [];
  const clearing: { at: number; kind: PoolItem["kind"]; taste?: TasteFit }[] = [];
  for (const v of verdicts) {
    const p = byId.get(v.id);
    if (!p || seen.has(v.id)) continue;
    seen.add(v.id);
    const base = { id: p.id, key: p.key, name: p.name, kind: p.kind, ...(v.rank ? { rank: v.rank } : {}), ...(v.forThem ? { forThem: v.forThem } : {}) };
    if (v.verdict === "send") {
      const bad = !v.whyMember || !v.whyNow ? "no why-member or why-now" : !v.wow ? "not a wow" : v.cites.some((x) => !known.has(x)) ? `cites a record that isn't there (${v.cites.filter((x) => !known.has(x)).join(", ")})` : !v.cites.some((x) => theirs.has(x)) ? "cites nothing they said or asked" : p.date && p.date < c.today ? "already past" : null;
      if (bad) out.push({ ...base, verdict: "reject", reason: "guard", why: v.whyMember || v.whyNow, cites: v.cites, whyNow: v.whyNow, guard: bad });
      // Time-bound and already past its last useful day: too late, and it doesn't take a send slot (2026-10-09).
      else if (v.lastDay && v.lastDay < c.today) out.push({ ...base, verdict: "reject", reason: "too_late", why: v.whyMember, cites: v.cites, whyNow: v.whyNow, guard: `its last day (${v.lastDay}) has passed` });
      else {
        // Its slot is decided below, once every send is known.
        const taste = c.roomTaste?.length ? v.taste ?? "neutral" : "neutral";
        clearing.push({ at: out.length, kind: p.kind, taste });
        out.push({ ...base, verdict: "send", reason: "clears_bar", why: v.whyMember, cites: v.cites, whyNow: v.whyNow, lastDay: v.lastDay, taste });
      }
    } else if (v.verdict === "hold") out.push({ ...base, verdict: "hold", reason: "not_today", why: v.why, until: v.until });
    else {
      // A reject that claims a closed or known record must cite one that can be about this find (Royce, 2026-10-14: "a reject claiming
      // 'closed' or 'already known' has to cite the actual record or the find survives"). One that doesn't is held, never exited, and
      // comes back the next day (GUARDED_HOLD_DAYS). On an hourly run it takes no send slot; on the 9am run it is still in its tier, so
      // it can be the tier's pick (tierPicks). Code refuses the claim it can't find; it never decides to send for that reason.
      // Whether a cited text, closed ask or goal really is about this find is the claim check's read (checkClaims).
      const read = RECORD_CLAIMS.includes(v.reason) ? checkCites(c, p, v.cites, known, v.reason) : null;
      const bad = read && "problem" in read ? read.problem : null;
      if (bad) out.push({ ...base, verdict: "hold", reason: "uncited_claim", why: v.why, cites: v.cites, until: plusDays(c.today, GUARDED_HOLD_DAYS), guard: `${UNCITED_CLAIM_GUARD}: ${bad}`, claimed: v.reason });
      else out.push({ ...base, verdict: "reject", reason: v.reason, why: v.why, ...(v.cites.length ? { cites: v.cites } : {}) });
    }
  }
  const slotted = new Set(slotOrder(clearing).slice(0, SELECT_LIMITS.maxSends));
  for (const x of clearing) {
    if (slotted.has(x.at)) continue;
    const j = out[x.at];
    out[x.at] = { id: j.id, key: j.key, name: j.name, kind: j.kind, ...(j.rank ? { rank: j.rank } : {}), ...(j.forThem ? { forThem: j.forThem } : {}), verdict: "hold", reason: "over_send_limit", why: j.why, cites: j.cites, whyNow: j.whyNow, until: null, taste: j.taste, guard: `over ${SELECT_LIMITS.maxSends} sends${x.kind === "discovery" && clearing.some((y) => y.kind === "answer" && slotted.has(y.at)) ? "; what they asked for went first" : ""}${x.taste === "clashes" ? "; it clashes with the room they said they want" : x.taste === "neutral" && clearing.some((y) => y.kind === x.kind && y.taste === "matches" && slotted.has(y.at)) ? "; a better fit for the room they said they want went first" : ""}` };
  }
  for (const p of c.pool) if (!seen.has(p.id)) out.push({ id: p.id, key: p.key, name: p.name, kind: p.kind, verdict: "no_verdict", reason: "no_verdict", why: "" });
  // covered: another candidate in today's pool does the job better. It must cite that candidate, and the candidate must still be in
  // the running (sent or held), or nothing covers it and it is held.
  for (let i = 0; i < out.length; i++) {
    const j = out[i];
    if (j.verdict !== "reject" || j.reason !== "covered" || j.guard) continue;
    const by = (j.cites ?? []).filter((x) => x !== j.id && out.some((o) => o.id === x && (o.verdict === "send" || o.verdict === "hold")));
    if (!by.length) out[i] = { ...j, verdict: "hold", reason: "uncited_claim", until: plusDays(c.today, GUARDED_HOLD_DAYS), guard: `covered names no candidate in today's pool still in the running (${(j.cites ?? []).join(", ") || "none cited"})`, claimed: "covered" };
  }
  return out;
}

// ---------- The claim check: is the cited record about THIS find, and does a judgment reject's why claim a record?
// One Haiku read per picker run, batched (the house pattern for narrow judges, services/memberLimits.ts). It answers:
//   R: for each record-claim reject whose cites code can't tie to the find (their text, a closed ask, a goal they closed), does the
//      record show they already know about, are going to, said no to, or finished THIS thing, with all their active goals in view;
//   U: for a ruled_out reject, do their own cited words rule out this thing or this kind of thing;
//   L: for a too_late reject (the picker's, or a send whose last day it said has passed), is it really over or too late, from the
//      find's own date and details;
//   W: for each other judgment reject (not_them, weak_fit, covered, other), does its why claim something is finished, closed or
//      already known. A yes makes it a record claim, held to the same cites.
// A no keeps the find: it is never exited for that claim (it waits in the backlog, and on the 9am run it stays in its tier). A read that
// couldn't run (timeout, error, unreadable) holds the find for that morning (Royce, 2026-10-14: "A failed check buys a hold, never a
// send"): never exited, never its tier's pick (heldBackFor), judged again on the next run under the guarded-hold bound, and logged as
// picker.claim_check_failed (sweepShadow.ts), which the hourly monitor counts (harness/monitor.ts).
export type ClaimJudge = (prompt: string) => Promise<{ text: string; input: number; output: number }>;
export const CLAIM_CHECK_MODEL = MODELS.haiku;
export const realClaimJudge: ClaimJudge = async (prompt) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    // Haiku with thinking off, through the SDK (the ai-sdk drops "thinking disabled", memberLimits.ts realJudgeDeps).
    const r: any = await new Anthropic().messages.create({ model: CLAIM_CHECK_MODEL, max_tokens: 800, thinking: { type: "disabled" }, messages: [{ role: "user", content: prompt }] } as any, { signal: ctl.signal });
    return { text: (r.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(""), input: Number(r.usage?.input_tokens ?? 0), output: Number(r.usage?.output_tokens ?? 0) };
  } finally {
    clearTimeout(t);
  }
};

// record: is the cited record about THIS find (q "known": they know, are going, said no, finished it; q "words": their own words rule
// it out). why: does a judgment reject's why claim a record. late: is a too_late reject really past or too late.
export type ClaimItem =
  | { id: string; kind: "record"; q: "known" | "words"; at: number; find: string; cite: string; record: string }
  | { id: string; kind: "why"; at: number; why: string }
  | { id: string; kind: "late"; at: number; find: string };

// Pure: what the run's rejects need read. A record-claim reject with a cite code already tied to this find needs nothing.
export function claimItems(c: SelectContext, judgments: Judgment[]): ClaimItem[] {
  const known = contextIds(c);
  const byId = new Map(c.pool.map((p) => [p.id, p]));
  const items: ClaimItem[] = [];
  const describe = (x: string): string => {
    const t = c.texts.find((y) => y.id === x);
    if (t) return `their own text ${x}: "${clip(t.text, 280)}"`;
    const a = c.asks.find((y) => y.id === x);
    if (a) return `an ask of theirs${a.closed ? ", now closed" : ""}, ${x}: "${clip(a.text, 220)}"`;
    const g = (c.goalsPast ?? []).find((y) => y.id === x);
    return g ? `a goal of theirs, ${pastWhy(g)}, ${x}: "${clip(g.text, 200)}"` : x;
  };
  judgments.forEach((j, at) => {
    // A send the guard turned into too_late (the picker's own last day has passed) is read like any too_late: the date is the picker's.
    if (j.verdict !== "reject" || (j.guard && !(j.reason === "too_late" && j.guard.startsWith("its last day")))) return;
    const p = byId.get(j.id);
    if (!p) return;
    const find = `${p.name}${p.date ? ` (${p.date})` : ""}${p.details ? `: ${clip(p.details, 160)}` : ""}`;
    const read = checkCites(c, p, j.cites ?? [], known, j.reason);
    const record = RECORD_CLAIMS.includes(j.reason as RejectReason);
    // Whether a too_late is real: it's the one reason a find leaves for its timing (heldBackFor), on any run.
    if (j.reason === "too_late") {
      items.push({ id: `L${items.length + 1}`, kind: "late", at, find });
      return;
    }
    if (!record) items.push({ id: `W${items.length + 1}`, kind: "why", at, why: clip(j.why, 300) });
    if ("problem" in read || read.facts.length) return;
    const q = j.reason === "ruled_out" ? ("words" as const) : ("known" as const);
    for (const cite of read.judge) items.push({ id: `${q === "words" ? "U" : "R"}${items.length + 1}`, kind: "record", q, at, find, cite, record: describe(cite) });
  });
  return items;
}

// Pure: the claim check's prompt. Every active goal is in it (the same list the picker reads), so a closed record about a different
// program can't pass for this one while a live goal carries the aim.
export function claimCheckPrompt(c: SelectContext, items: ClaimItem[]): string {
  const recs = items.filter((i): i is Extract<ClaimItem, { kind: "record" }> => i.kind === "record" && i.q === "known");
  const words = items.filter((i): i is Extract<ClaimItem, { kind: "record" }> => i.kind === "record" && i.q === "words");
  const whys = items.filter((i): i is Extract<ClaimItem, { kind: "why" }> => i.kind === "why");
  const lates = items.filter((i): i is Extract<ClaimItem, { kind: "late" }> => i.kind === "late");
  const lines = ["You check Co's reasons for leaving something out of a member's day. Answer only from what's written here.", "", "Their active goals (what they're working toward now):", (c.goals ?? []).length ? (c.goals ?? []).map((g) => `- ${clip(g, 200)}`).join("\n") : "(none on file)"];
  if (recs.length) {
    lines.push("", "RECORDS. For each, does the cited record show that the member already knows about, is going to, said no to, or finished THIS specific thing? A finished or closed record about a different program, ask or goal does not count, even if it is the same kind.");
    for (const r of recs) lines.push(`${r.id}: this thing: ${r.find}\n    the record: ${r.record}`);
  }
  if (words.length) {
    lines.push("", "THEIR WORDS. For each, do their own words in the record rule out this specific thing, or this kind of thing? Words about something else, or a preference this thing still fits, don't count.");
    for (const r of words) lines.push(`${r.id}: this thing: ${r.find}\n    the record: ${r.record}`);
  }
  if (lates.length) {
    lines.push("", `TIMING. Today is ${c.weekday} ${c.today}. For each, from this thing's own date and details, is it already over, closed, or too soon to act on (it starts before they could reasonably get there or apply)? Unsure is no.`);
    for (const l of lates) lines.push(`${l.id}: ${l.find}`);
  }
  if (whys.length) {
    lines.push("", "REASONS. For each, does this reason claim that something is finished, closed, done, set aside or already known to them (a goal or ask that ended, something they already have, are going to, or said no to)? Judging fit alone (not their scene, only loosely related, too far, too late) is not such a claim.");
    for (const w of whys) lines.push(`${w.id}: "${w.why}"`);
  }
  lines.push("", `Answer only with JSON: {"answers":[{"id":"R1","yes":false},{"id":"W1","yes":true}]}, one entry per id.`);
  return lines.join("\n");
}

// Pure: the answers by id; null when the read can't be used (then every item reads as failed).
export function readClaimCheck(raw: string, items: ClaimItem[]): Map<string, boolean> | null {
  const m = new Map<string, boolean>();
  try {
    const j = parseModelJson<{ answers?: { id?: unknown; yes?: unknown }[] }>(raw);
    for (const a of Array.isArray(j?.answers) ? j.answers : []) if (typeof a?.id === "string" && typeof a.yes === "boolean") m.set(a.id, a.yes);
  } catch {
    return null;
  }
  return items.some((i) => m.has(i.id)) ? m : null;
}

export type ClaimCheck = { calls: number; input: number; output: number; items: number; read: "model" | "failed" | "none"; error?: string; heldIds?: string[] };

// The claim check on a run's guarded judgments: a record claim whose record isn't about this find, and a judgment reject whose why
// claims a record it can't back, become holds (reason "uncited_claim", the model's why kept, the guard saying what failed).
export async function checkClaims(c: SelectContext, judgments: Judgment[], judge: ClaimJudge = realClaimJudge): Promise<{ judgments: Judgment[]; check: ClaimCheck }> {
  const items = claimItems(c, judgments);
  // Every run ends the same way: only a verified reason takes a find out; a fit-only reject waits in the backlog (onlyVerifiedExits).
  if (!items.length) return { judgments: onlyVerifiedExits(judgments), check: { calls: 0, input: 0, output: 0, items: 0, read: "none" } };
  let answers: Map<string, boolean> | null = null;
  let input = 0, output = 0;
  let error: string | undefined;
  try {
    const r = await judge(claimCheckPrompt(c, items));
    input = r.input;
    output = r.output;
    answers = readClaimCheck(r.text, items);
    if (!answers) error = `the answer couldn't be read: ${r.text.slice(0, 120)}`;
  } catch (err: any) {
    error = String(err?.message ?? err).slice(0, 200);
    console.error("picker: the claim check failed (the finds it was checking are held for this morning):", error);
  }
  const known = contextIds(c);
  const byId = new Map(c.pool.map((p) => [p.id, p]));
  const out = judgments.map((j, at) => {
    const mine = items.filter((i) => i.at === at);
    if (!mine.length) return j;
    // The check couldn't run: held for this morning, never sent for it, never exited (Royce, 2026-10-14).
    if (!answers) return { ...j, verdict: "hold" as const, reason: "uncited_claim", until: plusDays(c.today, GUARDED_HOLD_DAYS), guard: `the claim check couldn't run (${error ?? "unknown"}): held, judged again next run`, claimed: (REJECT_REASONS as readonly string[]).includes(j.reason) ? (j.reason as RejectReason) : undefined, checkFailed: true };
    const hold = (detail: string): Judgment => ({ ...j, verdict: "hold", reason: "uncited_claim", until: plusDays(c.today, GUARDED_HOLD_DAYS), guard: `${UNCITED_CLAIM_GUARD}: ${detail}`, claimed: j.reason as RejectReason });
    const w = mine.find((i) => i.kind === "why");
    let claimNote = "";
    if (w) {
      const says = answers?.get(w.id);
      // A judgment reject that doesn't claim a record stands as it is.
      if (says === false) return j;
      claimNote = says === true ? "its why claims something finished or known; " : "the read of its why failed; ";
      const read = checkCites(c, byId.get(j.id)!, j.cites ?? [], known, j.reason);
      if ("problem" in read) return hold(`${claimNote}${read.problem}`);
      if (read.facts.length) return { ...j, verified: true };
    }
    // Timing: a confirmed too_late stays a reject and is a real reason (heldBackFor); otherwise it is only a judgment, which never takes
    // a find out (onlyVerifiedExits) and which the morning's tier pick may still send.
    const l = mine.find((i) => i.kind === "late");
    if (l) return answers?.get(l.id) === true ? { ...j, late: true } : j;
    const recs = mine.filter((i) => i.kind === "record");
    if (recs.some((r) => answers?.get(r.id) === true)) return w ? { ...j, verified: true } : j;
    return hold(`${claimNote}${!answers ? "the record check couldn't be read" : `no cited record is about this find (${recs.map((r) => (r as any).cite).join(", ")})`}`);
  });
  return { judgments: onlyVerifiedExits(out), check: { calls: 1, input, output, items: items.length, read: answers ? "model" : "failed", ...(answers ? {} : { error: error ?? "unknown", heldIds: out.filter((j) => j.checkFailed).map((j) => j.id) }) } };
}

// ---------- One find per tier, every morning (Royce, 2026-10-14: "we are suppose to send one find per tier, but one not being available
// shouldn't stop things from being sent out"; 9/21: "always surface the 3 tiers if they are available", "we shouldn't force offers").
// On the 9am floor's run, for each tier with anything in the pool (1 Co events, 2 events, 3 openings), the best find in it goes. The
// picker ranks within a tier (fit and taste decide WHICH find goes, never WHETHER the tier sends), what they asked for first. A find is
// held back only for a reason code can verify (heldBackFor): it's past or confirmed too late to act on; they already have it, are going
// or said no to it, or it rests on something finished, with a cite the claim check tied to THIS find; or their own words rule it out,
// confirmed the same way. Then the next best in that tier goes. A tier is empty only when every find in it has such a reason.
export const tierOf = (p: Pick<PoolItem, "tier">): 1 | 2 | 3 => (p.tier === 1 || p.tier === 2 ? p.tier : 3);
// Pure: the verified reason a find can't go this morning, or null.
export function heldBackFor(j: Judgment): string | null {
  // A find whose claim check couldn't run is held for the morning: never its tier's pick.
  if (j.checkFailed) return `the claim check couldn't run: ${j.guard ?? ""}`;
  if (j.verdict !== "reject") return null;
  if (j.reason === "guard") return j.guard === "already past" ? "already past" : null;
  // Too late only when the claim check confirmed it from the find's own date and details, the picker's own last day included.
  if (j.reason === "too_late") return j.late ? `too late: ${j.guard ?? j.why}` : null;
  // Left unpicked for FIT_ONLY_MORNINGS mornings as a fit-only hold (carryGuardedRuns): it leaves, with its fact.
  if (j.reason === "aged_out") return j.guard ?? "aged out";
  if (RECORD_CLAIMS.includes(j.reason as RejectReason) && !j.guard) return `${j.reason}: ${j.why}`;
  // A judgment reject whose why claimed a record, backed by one about this find (checkClaims).
  if (j.verified) return `${j.reason}, backed by a record about this find: ${j.why}`;
  return null;
}
const VERDICT_CLASS = (j: Judgment) => (j.verdict === "send" || j.reason === "over_send_limit" ? 0 : j.verdict === "hold" && j.reason !== "fit_only" ? 1 : 2);
// Pure: the why a member may read for a find that goes. The picker's own why-member for a send; otherwise only its forThem line, never a
// reject's or a hold's reason (review of the tier PR: the composer was fed "doesn't match his practice area" as why it fits). Empty
// means the find's own details speak for it (queuePickedOffer falls back to the find's own whyItFits; the composer to its facts).
export function memberWhyOf(j: Pick<Judgment, "verdict" | "why" | "forThem" | "reason">): string {
  if (j.verdict === "send" && j.reason !== "tier_pick") return j.why;
  return j.forThem ?? "";
}

// Pure: the morning's sends, one per tier, from the run's guarded and checked judgments. The chosen find is a send (reason "tier_pick"
// unless the picker sent it itself), carrying the picker's why, or its forThem line for one it didn't send. Every other find in a tier:
// a held-back one keeps its reject (it exits as before); a send or a fit-only reject waits in the backlog (reason "tier_taken": its tier
// went this morning), so fit ranks a morning and never removes a find.
export function tierPicks(c: SelectContext, judgments: Judgment[]): Judgment[] {
  const order = new Map(c.pool.map((p, i) => [p.id, i]));
  const byId = new Map(c.pool.map((p) => [p.id, p]));
  const chosen = new Map<number, Judgment>();
  const alternates = new Map<string, string[]>();
  for (const t of [1, 2, 3] as const) {
    const inTier = judgments
      // A candidate the picker gave no verdict was never looked at: it waits (it has no why to send with).
      .filter((j) => byId.has(j.id) && tierOf(byId.get(j.id)!) === t && j.verdict !== "no_verdict" && !heldBackFor(j))
      .sort((a, b) => Number(b.kind === "answer") - Number(a.kind === "answer") || (a.rank ?? Infinity) - (b.rank ?? Infinity) || VERDICT_CLASS(a) - VERDICT_CLASS(b) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    if (inTier.length) {
      chosen.set(t, inTier[0]);
      // The rest of the tier, in order: tried the same morning if the chosen one can't be queued (sweepShadow.ts fillTiers).
      alternates.set(inTier[0].id, inTier.slice(1).map((j) => j.id));
    }
  }
  const chosenIds = new Set([...chosen.values()].map((j) => j.id));
  return judgments.map((j) => {
    const p = byId.get(j.id);
    if (!p) return j;
    const t = tierOf(p);
    if (chosenIds.has(j.id)) {
      const sent = j.verdict === "send";
      return { ...j, verdict: "send", reason: sent ? j.reason : "tier_pick", why: sent ? j.why : memberWhyOf(j), notSentWhy: sent ? undefined : j.why, whyNow: sent || j.reason === "over_send_limit" ? j.whyNow ?? "" : "", until: null, tierPick: t, tierAlternates: alternates.get(j.id) ?? [], ...(sent ? {} : { guard: `the best of its tier this morning${j.reason === "fit_only" || j.verdict === "reject" ? ` (Co said ${j.claimed ?? j.reason}, not a reason to hold it back)` : j.verdict === "hold" ? " (Co would have held it; not a reason to hold it back)" : ""}` }) };
    }
    if (heldBackFor(j) || j.verdict === "no_verdict") return j;
    const by = chosen.get(t);
    if (j.verdict === "hold" && j.reason !== "over_send_limit") return j;
    return { ...j, verdict: "hold", reason: "tier_taken", until: null, guard: `one find per tier: ${by ? `"${by.name}"` : "another"} went from its tier this morning${j.verdict === "reject" ? `; Co said ${j.reason}, which only ranks it` : ""}` };
  });
}

// ---------- Only a verified reason takes a find out (Royce, 2026-10-14, after one find per tier: weak_fit never holds a tier back, so no
// run may delete what tomorrow's morning would send). A reject the picker gave without one (not_them, weak_fit, covered, other, an
// unconfirmed too_late, or the send guard's "not a wow") becomes a hold, reason "fit_only": it stays in the backlog with the picker's
// why, never exits, and never buys a picker run of its own (holdDueDates leaves it out), so it can't loop; it is judged again at the
// next change. Verified reasons still exit as before: past or confirmed too late, closed or already_known with a cite about this find,
// or ruled_out confirmed against their own words.
export function onlyVerifiedExits(judgments: Judgment[]): Judgment[] {
  return judgments.map((j) =>
    j.verdict !== "reject" || heldBackFor(j)
      ? j
      : { ...j, verdict: "hold", reason: "fit_only", until: null, claimed: (REJECT_REASONS as readonly string[]).includes(j.reason) ? (j.reason as RejectReason) : undefined, guard: `${j.guard ? `${j.guard}; ` : ""}no verified reason to take it out (Co said ${j.reason}): it waits in the backlog` },
  );
}
// Holds code made that never buy a run of their own: a fit-only reject, and a tier's runner-up (the next morning runs anyway).
export const NO_RUN_HOLDS: readonly string[] = ["fit_only", "tier_taken"];

// Skip unchanged days: the same pool, the same asks and nothing new from them
// since the last run gets the same answer, so it isn't paid for again. Time
// still counts: a hold whose date has come, or a candidate moving inside three
// days, changes the signature, so nothing held waits forever on a quiet day.
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
// When each hold from a run comes due: its own date, or two days after the run
// when Co gave none (review of #57: an undated hold never came back).
export const UNDATED_HOLD_DAYS = 2;
// A reject the guard held comes due the next day, so tomorrow's run judges it again even when nothing else changed. It buys at most
// GUARDED_RECHECKS such runs of its own (the next three days), plus one more as it drops out of what's due; after that it waits like any
// find for the next change to their pool, asks or texts (it is judged then, once), so one uncited claim repeated can't cost a picker
// run every day until its date.
export const GUARDED_HOLD_DAYS = 1;
export const GUARDED_RECHECKS = 3;
export const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export function holdDueDates(judgments: { verdict: string; until?: string | null; reason?: string; guardedRuns?: number }[], runDay: string): string[] {
  // Past its rechecks, a guarded hold is left out: it buys no run of its own. Leaving it out costs one extra run at the cap (what's due
  // changes once), and nothing after: a due date pinned to the run's day re-armed a run every day after any later change (review of the
  // picker guard, 2026-10-14). A fit-only hold and a tier's runner-up are left out from the start (NO_RUN_HOLDS).
  return judgments
    .filter((j) => j.verdict === "hold" && !NO_RUN_HOLDS.includes(j.reason ?? "") && !(j.reason === "uncited_claim" && (j.guardedRuns ?? 1) > GUARDED_RECHECKS))
    .map((j) => j.until ?? plusDays(runDay, UNDATED_HOLD_DAYS));
}
// Pure: each guarded hold counts the runs in a row its find has been held that way, from the last run's judgments.
// morning: this is the 9am run. A fit-only hold counts the mornings it has gone unpicked (fitOnlyMornings, carried through hourly runs);
// at FIT_ONLY_MORNINGS it ages out: a reject (reason "aged_out", a verified reason), so it leaves the backlog with its exit fact
// (review of the tier PR: fit-only holds never left, so the backlog grew without bound past the prompt's 40). Five: a working week of
// mornings on which the picker had it in view and chose something else from its tier each time; a find that loses five mornings
// running isn't going to be the one, and the backlog stays near five days of finds.
export const FIT_ONLY_MORNINGS = 5;
export function carryGuardedRuns(judgments: Judgment[], last: Pick<Judgment, "key" | "reason" | "guardedRuns" | "fitOnlyMornings">[], o: { morning?: boolean } = {}): Judgment[] {
  return judgments.map((j) => {
    if (j.reason === "fit_only") {
      const before = last.find((x) => x.key === j.key && x.reason === "fit_only")?.fitOnlyMornings ?? 0;
      const n = before + (o.morning ? 1 : 0);
      if (n >= FIT_ONLY_MORNINGS) {
        const note = `left unpicked for ${n} mornings as a fit-only hold (Co said ${j.claimed ?? "it only loosely fits"})`;
        // Its why becomes the exit fact's reason (sweepShadow.ts rejectedFindsOf): it says it aged out, with the picker's own why.
        return { ...j, verdict: "reject", reason: "aged_out", fitOnlyMornings: n, why: `${note}: ${j.why}`, guard: `${note}: it leaves the backlog` };
      }
      return { ...j, fitOnlyMornings: n };
    }
    if (j.reason !== "uncited_claim") return j;
    const before = last.find((x) => x.key === j.key && x.reason === "uncited_claim");
    return { ...j, guardedRuns: (before ? before.guardedRuns ?? 1 : 0) + 1 };
  });
}
export function selectSignature(c: SelectContext, holdsUntil: (string | null)[] = []): string {
  const soon = c.pool.filter((p) => p.date && daysBetween(c.today, p.date) <= 3).map((p) => `soon:${p.key}`);
  const due = holdsUntil.filter((d): d is string => !!d && d <= c.today).map((d) => `due:${d}`);
  const lastFromThem = c.texts.filter((t) => t.from === "member").slice(-1)[0]?.at ?? "";
  const parts = [...c.pool.map((p) => p.key).sort(), "|", ...c.asks.map((a) => a.id).sort(), "|", lastFromThem, "|", String(c.discoveryLeft), "|", ...soon.sort(), ...due.sort(), "|", ...(c.roomTaste ?? [])];
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

// set: the pick's view of the day's sends together (Phase C3: it was never asked for, so the text had nothing to say why these, together).
// claimCheck: the claim check's read for this run (checkClaims): calls, tokens and whether it read.
export type SelectResult = { judgments: Judgment[]; set?: string | null; raw: string; usage: { input: number; cacheRead: number; cacheWrite: number; output: number }; model: string; error?: string; claimCheck?: ClaimCheck };

export async function selectForMember(c: SelectContext, opts: { model?: string; userId?: string; effort?: "low" | "medium" | "high"; judge?: ClaimJudge } = {}): Promise<SelectResult> {
  const model = opts.model ?? SELECT_MODEL;
  try {
    const r = await generateText({
      model: anthropic(model),
      // Room to think, then answer: at 6000 the whole budget went to thinking
      // and no verdicts came back (2026-10-02 replay). Medium effort, like the
      // review's judgment call (harness/devReview.ts).
      maxOutputTokens: 16_000,
      providerOptions: { anthropic: { effort: opts.effort ?? "medium" } },
      experimental_telemetry: { isEnabled: true, functionId: "sweep.select", metadata: { userId: opts.userId ?? "" } },
      // The instructions are the same for every member: cached across a sweep batch.
      system: [{ role: "system" as const, content: SELECT_SYSTEM, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }],
      prompt: selectPrompt(c),
    });
    const verdicts = parseVerdicts(r.text);
    const u: any = r.usage ?? {};
    const usage = {
      input: Number(u.inputTokenDetails?.noCacheTokens ?? u.inputTokens ?? 0),
      cacheRead: Number(u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? 0),
      cacheWrite: Number(u.inputTokenDetails?.cacheWriteTokens ?? 0),
      output: Number(u.outputTokens ?? 0),
    };
    if (!verdicts) return { judgments: guardVerdicts(c, []), raw: r.text, usage, model, error: "unreadable verdicts" };
    const checked = await checkClaims(c, guardVerdicts(c, verdicts), opts.judge);
    // The 9am floor's run: one find per tier (tierPicks), after the guard and the claim check have said what's really held back.
    if (c.morning) checked.judgments = tierPicks(c, checked.judgments);
    return { judgments: checked.judgments, set: parseSet(r.text), raw: r.text, usage, model, claimCheck: checked.check };
  } catch (err: any) {
    return { judgments: guardVerdicts(c, []), raw: "", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, model, error: String(err?.message ?? err) };
  }
}
