// What a member ruled out, applied where Co looks and where it keeps (Royce, 2026-10-09 audit, Phase A2). When a member says "no more
// hackathons", Co tells them it will stop suggesting it "in every search and sweep" (agent/conversationTools.ts steerAwayFrom). The
// list (co_profiles.avoid) was read only by eventDetails.ts explainFit, which the sweep never calls, so the sweep kept, queued and sent
// what they'd ruled out. When they're usually free (availability) was the same: checked for a texted search, never for the sweep.
//
// The facts are read once, by the member record (services/memberKnowledge.ts, the "limits" section). This file applies them:
//   - planning: a search (a sweep query, a goal's edge) that names a kind they ruled out isn't run (code: their own words, whole words);
//   - keeping: each thing kept is judged against the list by its main activity (one Haiku read for the whole keep, the same test
//     explainFit uses), and an event whose start falls outside when they're free is out (code, services/availability.ts);
//   - the working set: a kind ruled out takes what's already waiting for them out too, with its fact (services/workingSet.ts).
// A kind they name in the ask being searched is theirs again for that ask: the ask is newer than the rule.
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../models.js";
import { availabilityConflict } from "./availability.js";
import { recordAnthropicUsage } from "./llmUsage.js";

// rules: the standing rules they set for how Cue treats them (services/memberPreferences.ts), in force now, read with the rest of their
// limits so every reader of the record (calls, tasks, dispatch drafts, sweeps in PR C) gets them from the same read.
// area: their search area (services/searchArea.ts), read with the rules when one is about where to search, so a call says such a rule
// is applied only while it really is.
export type Limits = { avoid: string[]; availability: string | null; rules?: import("./memberPreferences.js").Preference[]; area?: import("./memberPreferences.js").ApplyCtx };

// Words that name the shape of a thing, not its kind ("crypto events" is the kind "crypto").
const SHAPE = new Set(["event", "events", "thing", "things", "stuff", "kind", "kinds", "type", "types", "anything", "any", "more", "the", "a", "an", "of", "to", "for", "and", "or"]);
const tokens = (s: string) => (s.toLowerCase().match(/[a-z0-9+#]+/g) ?? []);
// One form for singular and plural ("hackathons" and "hackathon" are the same word here).
// Words that only look plural ("news" is not "new", "series" not "sery").
const NOT_PLURAL = new Set(["news", "series", "species", "analytics", "physics", "politics", "economics", "athletics", "aerobics", "gymnastics", "business", "class", "glass", "chess", "dress", "press", "fitness", "wellness", "yoga", "plus", "bus", "campus", "always", "towards"]);
const stem = (w: string) => (NOT_PLURAL.has(w) ? w : w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && /(?:ss|us)$/.test(w) ? w : w.length > 3 && w.endsWith("es") && /(?:ch|sh|x|z)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
// Words that describe how a thing is, not what it is ("big", "late", "loud"): a kind made only of these ("big events", "anything late")
// can't be matched on words (review of #134: "anything late" refused "SF founder dinner late October"). The judge reads those at keep.
const MANNER = new Set(["big", "small", "large", "huge", "late", "early", "loud", "quiet", "long", "short", "new", "old", "fancy", "casual", "formal", "crowded", "busy", "expensive", "cheap", "far", "night", "morning", "weekend", "weekday", "online", "virtual", "boring", "fun", "good", "bad"]);
// Pure: the words that make a kind what it is. Empty when nothing in it can be matched on words.
export function kindWords(kind: string): string[] {
  const all = tokens(kind).map(stem);
  const core = all.filter((w) => !SHAPE.has(w));
  const words = core.length ? core : all;
  return words.every((w) => MANNER.has(w)) ? [] : words;
}

// Pure: the ruled-out kinds a text names, in their own words, whole words (every word of the kind present).
export function avoidHits(text: string, avoid: string[]): string[] {
  const have = new Set(tokens(text).map(stem));
  return avoid.filter((k) => {
    const w = kindWords(k);
    return w.length > 0 && w.every((x) => have.has(x));
  });
}

// Pure: the list that applies to one ask: a kind the ask itself names is theirs again for it.
// A kind named only to rule it out ("no more hackathons", "stop sending me crypto stuff", "not into mixers or crypto events", "anything but
// crypto events") is the rule restated, never the ask taking it back (2026-10-11). Narrow on purpose: "I don't mind hackathons", "don't
// forget to look for hackathons" and "less talking more hackathons" ask for it (review of #139: a wide "don't …" and "less" kept those).
// The negation reaches the kind through at most four words in the same clause, so a list stays negated ("never again with crypto events
// and hackathons") and "but" starts a new clause (except "anything but", which is the negation itself).
const NEGATION = /\b(?:no more|no|not(?: into| interested in| a fan of| for me)?|never(?: again)?(?: with)?|stop(?:ping)? (?:sending|suggesting|showing|offering)(?: me)?|don'?t (?:send|suggest|show|offer|want)(?: me)?(?: any)?|tired of|sick of|done with|enough(?: with)?|skip(?:ping)?|avoid|anything but|nothing like|except|without)(?:\s+[\w'-]+){0,4}\s*$/i;
function namedToAsk(text: string, kind: string): boolean {
  const words = kindWords(kind);
  if (!words.length) return false;
  const re = new RegExp(`\\b${words[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi");
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 80), m.index ?? 0);
    const clause = before.split(/[.;:!?\n]|(?<!\b(?:anything|everything|nothing)\s)\bbut\b/i).pop() ?? "";
    // A comma ends the clause unless a list continues it ("not into mixers, crypto events or hackathons").
    const lastComma = clause.lastIndexOf(",");
    const scope = lastComma >= 0 && !/^\s*(?:[\w'-]+\s+){0,3}(?:or|and)?\s*$/i.test(clause.slice(lastComma + 1)) ? clause.slice(lastComma + 1) : clause;
    if (!NEGATION.test(scope)) return true;
  }
  return false;
}
export function avoidFor(avoid: string[], askText: string | null | undefined): string[] {
  const clean = avoid.map((a) => a.trim()).filter(Boolean);
  if (!askText?.trim()) return clean;
  const named = new Set(avoidHits(askText, clean).filter((k) => namedToAsk(askText, k)));
  return clean.filter((k) => !named.has(k));
}

// ---------- keeping: the judge

export type Judged = { name: string; details: string };

export function avoidPrompt(items: Judged[], avoid: string[]): string {
  return `A member told Cue to stop suggesting these kinds of things: ${avoid.map((a) => `"${a}"`).join(", ")}.

For each thing below, say which of those kinds it clearly is, judged by its own main activity (who attends, hosts or sponsors never changes what kind of thing it is: a chess night full of founders is a chess night). If it isn't clearly one of them, null.

${items.map((it, i) => `${i + 1}. ${it.name}\n${it.details.replace(/\s+/g, " ").slice(0, 600) || "(only the name)"}`).join("\n\n")}

Answer only with JSON: [{"n": 1, "kind": "one of the kinds above, exactly as written" | null}, ...]`;
}

// Pure: the judge's answer, checked in code: a kind must be one on the list. Null: the answer couldn't be read.
export function readAvoidAnswer(raw: string, count: number, avoid: string[]): (string | null)[] | null {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return null;
  let arr: any[];
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const byLower = new Map(avoid.map((a) => [a.toLowerCase().trim(), a]));
  const out: (string | null)[] = [];
  for (let i = 0; i < count; i++) {
    const r = arr.find((x) => Number(x?.n) === i + 1);
    if (!r) return null;
    const k = typeof r.kind === "string" ? byLower.get(r.kind.toLowerCase().trim()) ?? null : null;
    out.push(k);
  }
  return out;
}

export type JudgeDeps = { model: (prompt: string) => Promise<string> };
export const realJudgeDeps: JudgeDeps = {
  // Haiku with thinking off, through the SDK (the ai-sdk drops "thinking disabled", services/goalEdges.ts).
  model: async (prompt) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r: any = await new Anthropic().messages.create({ model: MODELS.haiku, max_tokens: 400, thinking: { type: "disabled" }, messages: [{ role: "user", content: prompt }] } as any, { signal: ctl.signal });
      recordAnthropicUsage("memberLimits.judge", r.model ?? MODELS.haiku, r.usage);
      return (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    } finally {
      clearTimeout(t);
    }
  },
};

// Which ruled-out kind each thing is (null: none). One read for all of them; when it can't be read, their own words decide (avoidHits on
// the name and details), so the rule never lapses on a failed call.
export async function judgeAvoided(items: Judged[], avoid: string[], deps: JudgeDeps = realJudgeDeps): Promise<{ kinds: (string | null)[]; read: "model" | "words" }> {
  if (!items.length || !avoid.length) return { kinds: items.map(() => null), read: "model" };
  const raw = await deps.model(avoidPrompt(items, avoid)).catch(() => "");
  const kinds = readAvoidAnswer(raw, items.length, avoid);
  if (kinds) return { kinds, read: "model" };
  return { kinds: items.map((it) => avoidHits(`${it.name} ${it.details}`, avoid)[0] ?? null), read: "words" };
}

// Pure: what's known about a kept thing, for the judge.
export function judgedOf(m: any): Judged {
  const d = m?.details;
  const lines = [d?.description, d?.summary, m?.reason, m?.evidence, m?.whyItFits].filter((x) => typeof x === "string" && x.trim());
  return { name: String(m?.name ?? ""), details: lines.join(" ").slice(0, 600) };
}

// An ask that names a day or a time asks for it: when they're usually free doesn't overrule it (review of #134: "anything this Saturday?"
// from a "weeknights" member had every Saturday item refused).
// Days and plain when-words only: "trivia night", "lunch spots" or "morning run club" name a kind of thing, not when (re-review of #134).
const NAMES_A_TIME = /\b(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?s?\b|\b(weekends?|weekdays?|weeknights?|tonight|tomorrow|today|this (?:week|morning|afternoon|evening)|next week|(?:after|before) work|(?:after|before) \d{1,2}(?::\d{2})?\s?(?:am|pm)?|(?:at|around|from) \d{1,2}(?::\d{2}\s?(?:am|pm)?|\s?(?:am|pm))|\d{1,2}(?::\d{2})?\s?(?:am|pm)|(?:mornings|afternoons|evenings) (?:this|next) (?:week|month))\b/i;
export function askNamesATime(askText: string | null | undefined): boolean {
  return NAMES_A_TIME.test(askText ?? "");
}

// The keep, held to their limits: a kind they ruled out is out, and so is an event that starts outside when they're free (unless the ask
// itself names a day or time). `out` says why, in words fit for the log and the record.
// Subjects they asked Cue not to bring up (services/prefTopics.ts, member preferences PR C): read against each thing by a model read of
// what it's about, never words matched in code; when that read can't be had, nothing is kept (never shown unread).
export async function limitsGate<M>(matches: M[], limits: Limits | null, o: { askText?: string | null; deps?: JudgeDeps; topicDeps?: JudgeDeps } = {}): Promise<{ kept: M[]; out: { match: M; why: string }[]; read: "model" | "words" | null }> {
  if (!limits || !matches.length) return { kept: matches, out: [], read: null };
  const avoid = avoidFor(limits.avoid, o.askText);
  const T = limits.rules?.length ? await import("./prefTopics.js") : null;
  const topics = T ? T.topicsToAvoid(limits.rules) : [];
  const [{ kinds, read }, topicKinds] = await Promise.all([
    avoid.length ? judgeAvoided(matches.map(judgedOf), avoid, o.deps) : Promise.resolve({ kinds: matches.map(() => null), read: null as null }),
    T && topics.length ? T.judgeTopics(matches.map(judgedOf), topics, { ask: o.askText, deps: o.topicDeps ?? o.deps }) : Promise.resolve(matches.map(() => null) as (string | null)[]),
  ]);
  const kept: M[] = [];
  const out: { match: M; why: string }[] = [];
  matches.forEach((m, i) => {
    if (kinds[i]) return out.push({ match: m, why: `they asked Cue to stop suggesting ${kinds[i]}` });
    if (!topicKinds) return out.push({ match: m, why: "a subject they asked Cue not to bring up couldn't be checked just now" });
    if (topicKinds[i]) return out.push({ match: m, why: `they asked Cue not to bring up ${topicKinds[i]}` });
    const d = (m as any)?.details;
    const conflict = askNamesATime(o.askText) ? null : availabilityConflict(limits.availability, d?.startAt ?? null, d?.timezone ?? null);
    if (conflict) return out.push({ match: m, why: conflict });
    kept.push(m);
  });
  return { kept, out, read };
}
