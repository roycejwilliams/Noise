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
// a send says why-member, why-now and wow.
import { createHash } from "crypto";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS } from "../models.js";

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
  goals?: string[]; // where they are headed (active goals only): the lens, judged against alongside the asks, never recited
  goalsPast?: string[]; // goals done or set aside: history, never the lens
  asks: { id: string; text: string; since: string; closed?: boolean }[]; // A#
  texts: { id: string; at: string; from: "member" | "co"; text: string }[]; // T#
  sent: { id: string; at: string; what: string; reaction: string | null }[]; // S#
  outcomes: { id: string; at: string; item: string; result: string; note: string | null }[]; // O#
  feeling: string | null;
  // From the shared member layer (services/memberKnowledge.ts), live runs only: what Co already gave them, what it is carrying,
  // what it has learned (corrections, lessons, taste), its read of them, and the member-level rules (memberRules).
  delivered?: { what: string; kind: string; at: string; reaction: string | null }[];
  carrying?: string[];
  learned?: string[];
  person?: string | null;
  rules?: string[];
  // What kind of room they've told Co they want or don't (services/roomTaste.ts), newest first: candidates are ranked by it.
  roomTaste?: string[];
  discoveryLeft: number; // discovery sends left this week
  pool: PoolItem[];
};

// How a candidate fits the room they've said they want: ranks sends within their kind (slotOrder). "neutral" when nothing was said.
export type TasteFit = "matches" | "neutral" | "clashes";
export type Verdict =
  | { id: string; verdict: "send"; whyMember: string; cites: string[]; whyNow: string; wow: boolean; lastDay: string | null; taste?: TasteFit }
  | { id: string; verdict: "hold"; why: string; until: string | null }
  | { id: string; verdict: "reject"; reason: RejectReason; why: string };

export const REJECT_REASONS = ["not_them", "weak_fit", "too_late", "covered", "already_known", "other"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

// The part that's the same for every member: cached across a sweep batch.
export const SELECT_SYSTEM = `You're Co. You know this member well. A search already gathered a pool of things that might be worth texting them about. Your job is to decide, for each one, whether it goes out today.

The bar is: they'd reply "wow". Not "seems relevant", not "fits a keyword in their ask". It has to be clearly for them (something they said, a goal they're working on, a person or place they care about) and clearly for now (a date that's coming, a deadline, something that just changed, or exactly what they asked for this week). If you can't say both, it doesn't go today.

For every candidate, give one verdict:
- "send": it clears the bar today. Say why this member, citing the records it rests on by id (A# their asks, T# texts, S# what Co sent before, O# how they reacted), why now, and "wow": true only if you'd genuinely expect that reaction. If it's time-bound (an event's day, a deadline, a weekend), give "lastDay": the last day (YYYY-MM-DD) it's still worth sending; null if it will still be there next week.
- "hold": good for them, but not today (too early, a better moment is coming, it would crowd a stronger send). Say when it would be right, as a date (YYYY-MM-DD) if you can.
- "reject": not for them. Give a reason code: not_them (doesn't match who they are), weak_fit (only loosely related), too_late (passed or too short notice to act on), covered (another candidate does the same job better; name it), already_known (they mentioned it, are going, or said no), other. Add one line why.

An ask isn't finished after one send: someone looking for events this week usually wants a few across the week, and a search for a community can take several tries. What Co already sent for an ask only counts against a candidate when it's the same kind of thing for the same moment. "covered" means another candidate in today's pool does the same job better, not that the ask got something before.

Some candidates come with only a name and a date. Judge what the name tells you; thin isn't the same as weak.

Things they asked for and things you'd bring up yourself clear the same bar. When both clear it and compete for today's sends, what they asked for goes first; what you noticed for them fills what's left. Send at most ${SELECT_LIMITS.maxSends}, the strongest first; usually one or none. Sending nothing today is a good answer when nothing clears the bar. Use only what's in the records; never assume something they didn't say.

When you send more than one, add "set": one line on why these go together today (what they share for this member, or how they differ), in plain words; it's what Co's message opens with. Leave it out for one send or none.

Return ONLY JSON:
{"set":"...","verdicts":[{"id":"C1","verdict":"send","whyMember":"...","cites":["A2","T5"],"whyNow":"...","wow":true,"lastDay":"2026-10-08","taste":"matches"},{"id":"C2","verdict":"hold","why":"...","until":"2026-10-08"},{"id":"C3","verdict":"reject","reason":"weak_fit","why":"..."}]}`;

// What the thing is, not a rank: tier numbers read as a quality score (the
// 2026-10-02 replay rejected things for being "tier 3").
const SOURCE_LABEL: Record<number, string> = { 1: "a Co event", 2: "an event", 3: "an opening (program, place or opportunity)" };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Pure: the member part of the prompt.
export function selectPrompt(c: SelectContext): string {
  const lines: string[] = [];
  lines.push(`Member: ${c.firstName}${c.city ? `, ${c.city}` : ""}. Today: ${c.weekday} ${c.today}${c.zone ? ` (their time, ${c.zone})` : ""}.`);
  lines.push(`Discovery texts left this week: ${c.discoveryLeft} (things they asked for don't use these).`);
  if (c.feeling) lines.push(`How they've been: ${c.feeling}`);
  lines.push(`\nWhat they've asked Co for (open):`);
  lines.push(c.asks.length ? c.asks.map((a) => `${a.id} (since ${a.since}${a.closed ? ", closed since" : ""}): ${clip(a.text, 220)}`).join("\n") : "(none)");
  if (c.goals?.length) lines.push("", "Where they say they are headed (the LENS: judge every candidate against this as well as the asks; never cite it as the reason, the reason is an ask, a text, or what they did):", c.goals.map((g) => `- ${clip(g, 200)}`).join("\n"));
  if (c.goalsPast?.length) lines.push("", "Goals they've finished or set aside (history, NOT the lens: never pick something for one of these):", c.goalsPast.map((g) => `- ${clip(g, 200)}`).join("\n"));
  if (c.person) lines.push("", "Co's read of them:", clip(c.person, 1500));
  if (c.learned?.length) lines.push("", "What Co has learned about them (a correction replaces what it corrects):", c.learned.map((l) => `- ${clip(l, 200)}`).join("\n"));
  if (c.delivered?.length) lines.push("", "What they already have from Co (never pick the same thing again as news; a reminder of something they're going to is different):", c.delivered.map((d) => `- ${clip(d.what, 120)} (${d.kind}, ${d.at})${d.reaction ? ` → ${d.reaction}` : ""}`).join("\n"));
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
    if (v.verdict === "send") out.push({ id, verdict: "send", whyMember: String(v.whyMember ?? "").trim(), cites: Array.isArray(v.cites) ? v.cites.map(String) : [], whyNow: String(v.whyNow ?? "").trim(), wow: v.wow === true , lastDay: /^\d{4}-\d{2}-\d{2}$/.test(String(v.lastDay ?? "")) ? String(v.lastDay) : null, taste: tasteFitOf(v.taste) });
    else if (v.verdict === "hold") out.push({ id, verdict: "hold", why: String(v.why ?? "").trim(), until: /^\d{4}-\d{2}-\d{2}$/.test(String(v.until ?? "")) ? String(v.until) : null });
    else if (v.verdict === "reject") out.push({ id, verdict: "reject", reason: (REJECT_REASONS as readonly string[]).includes(v.reason) ? v.reason : "other", why: String(v.why ?? "").trim() });
  }
  return out;
}

// One row per candidate: what was decided and why, including what code changed.
export type Judgment = { id: string; key: string; name: string; kind: PoolItem["kind"]; verdict: "send" | "hold" | "reject" | "no_verdict"; reason: string; why: string; cites?: string[]; whyNow?: string; until?: string | null; guard?: string; lastDay?: string | null ; taste?: TasteFit };

// Pure: which sends get the day's slots first: answers to their asks, then goal finds, each in the model's order.
// Within each kind, what fits the room they've said they want goes first and what clashes with it last (Royce, 2026-10-09: "a member
// telling Co what kind of room they want is the highest-quality signal the picker will ever get").
const TASTE_RANK: Record<TasteFit, number> = { matches: 0, neutral: 1, clashes: 2 };
export function slotOrder(clearing: { at: number; kind: PoolItem["kind"]; taste?: TasteFit }[]): number[] {
  const byTaste = (xs: typeof clearing) => [...xs].sort((a, b) => TASTE_RANK[a.taste ?? "neutral"] - TASTE_RANK[b.taste ?? "neutral"]);
  return [...byTaste(clearing.filter((x) => x.kind === "answer")), ...byTaste(clearing.filter((x) => x.kind !== "answer"))].map((x) => x.at);
}

// Pure: facts only. A send must cite records that exist (at least one of
// theirs: an ask, a text, an outcome), say why-member and why-now, mean wow,
// and not be in the past. Over the send limit, the rest are held. Asks win
// contested slots (Royce, 2026-10-09: "asks are orders"): what they asked for
// takes the day's sends first, in the model's order, and goal finds fill what's
// left, in the model's order. Anything left without a verdict is logged as such.
export function guardVerdicts(c: SelectContext, verdicts: Verdict[]): Judgment[] {
  const known = new Set([...c.asks.map((a) => a.id), ...c.texts.map((t) => t.id), ...c.sent.map((s) => s.id), ...c.outcomes.map((o) => o.id)]);
  const theirs = new Set([...c.asks.map((a) => a.id), ...c.texts.filter((t) => t.from === "member").map((t) => t.id), ...c.outcomes.map((o) => o.id)]);
  const byId = new Map(c.pool.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: Judgment[] = [];
  const clearing: { at: number; kind: PoolItem["kind"]; taste?: TasteFit }[] = [];
  for (const v of verdicts) {
    const p = byId.get(v.id);
    if (!p || seen.has(v.id)) continue;
    seen.add(v.id);
    const base = { id: p.id, key: p.key, name: p.name, kind: p.kind };
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
    else out.push({ ...base, verdict: "reject", reason: v.reason, why: v.why });
  }
  const slotted = new Set(slotOrder(clearing).slice(0, SELECT_LIMITS.maxSends));
  for (const x of clearing) {
    if (slotted.has(x.at)) continue;
    const j = out[x.at];
    out[x.at] = { id: j.id, key: j.key, name: j.name, kind: j.kind, verdict: "hold", reason: "over_send_limit", why: j.why, cites: j.cites, whyNow: j.whyNow, until: null, taste: j.taste, guard: `over ${SELECT_LIMITS.maxSends} sends${x.kind === "discovery" && clearing.some((y) => y.kind === "answer" && slotted.has(y.at)) ? "; what they asked for went first" : ""}${x.taste === "clashes" ? "; it clashes with the room they said they want" : x.taste === "neutral" && clearing.some((y) => y.kind === x.kind && y.taste === "matches" && slotted.has(y.at)) ? "; a better fit for the room they said they want went first" : ""}` };
  }
  for (const p of c.pool) if (!seen.has(p.id)) out.push({ id: p.id, key: p.key, name: p.name, kind: p.kind, verdict: "no_verdict", reason: "no_verdict", why: "" });
  return out;
}

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
export function holdDueDates(judgments: { verdict: string; until?: string | null }[], runDay: string): string[] {
  const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  return judgments.filter((j) => j.verdict === "hold").map((j) => j.until ?? plus(runDay, UNDATED_HOLD_DAYS));
}
export function selectSignature(c: SelectContext, holdsUntil: (string | null)[] = []): string {
  const soon = c.pool.filter((p) => p.date && daysBetween(c.today, p.date) <= 3).map((p) => `soon:${p.key}`);
  const due = holdsUntil.filter((d): d is string => !!d && d <= c.today).map((d) => `due:${d}`);
  const lastFromThem = c.texts.filter((t) => t.from === "member").slice(-1)[0]?.at ?? "";
  const parts = [...c.pool.map((p) => p.key).sort(), "|", ...c.asks.map((a) => a.id).sort(), "|", lastFromThem, "|", String(c.discoveryLeft), "|", ...soon.sort(), ...due.sort(), "|", ...(c.roomTaste ?? [])];
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

// set: the pick's view of the day's sends together (Phase C3: it was never asked for, so the text had nothing to say why these, together).
export type SelectResult = { judgments: Judgment[]; set?: string | null; raw: string; usage: { input: number; cacheRead: number; cacheWrite: number; output: number }; model: string; error?: string };

export async function selectForMember(c: SelectContext, opts: { model?: string; userId?: string; effort?: "low" | "medium" | "high" } = {}): Promise<SelectResult> {
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
    return { judgments: guardVerdicts(c, verdicts), set: parseSet(r.text), raw: r.text, usage, model };
  } catch (err: any) {
    return { judgments: guardVerdicts(c, []), raw: "", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, model, error: String(err?.message ?? err) };
  }
}
