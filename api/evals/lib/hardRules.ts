// Hard rules for a reply, checked by code (Royce, 2026-10-29: "Let code check the hard rules: no invented facts, no status lines, no
// stock phrases, no machinery talk. Free, deterministic, not tied to exact wording"). Every golden reply (evals/golden/replies.ts) and
// every texting-eval reply (evals/texting/grade.ts, pairwise.ts) runs through these, in replay and live alike. Pure: no model, no I/O.
//
// Each rule is a line Cue never crosses, written tight so a miss is a real one; tone and depth are the model judge's (evals/lib/
// replyRubric.ts), in the scheduled quality run. The matchers are the product's own where one exists:
//   invented:   services/offerGuard.ts spokenProblem (every name, place, clock time and number has to be in what the turn stood on)
//   stock:      harness/stockLines.ts stockLine and textStockSentence
import { prepareSource, spokenProblem, SPOKEN_COMMON } from "../../src/services/offerGuard.js";
import { stockLine, textStockSentence } from "../../src/harness/stockLines.js";

export type TurnKind = "checkin" | "share" | "feedback" | "find" | "reply";
// One text that went out this turn: Cue's reply (sendReply), a find or link line (shareFinds, shareLink), or the fallback.
export type Send = { kind: "reply" | "find" | "link" | "fallback"; text: string };

export type HardRuleInput = {
  // Everything Cue sent this turn, joined (the reply as the member reads it).
  text: string;
  // Each text that went out, in order. Without it, the text counts as one reply.
  sends?: Send[];
  tools?: string[];
  kind: TurnKind;
  // What the turn stood on: the rendered facts, what Cue knows about them, their world. A name or number from here is not invented.
  facts: string;
  // The member's own words: this message and their earlier lines.
  theirLines: string[];
  // Cue's earlier lines in the thread (a quote of one back is a miss; they also back a name: they are the case's given history).
  coLines: string[];
  firstName?: string;
  // The finds this turn carried (their links), for link-then-caption.
  findUrls?: string[];
};

const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
const words = (s: string) => norm(s).toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
export const sentencesOf = (text: string) => norm(text).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const URL_RE = /https?:\/\/[^\s"'<>)]+/g;
const bareUrl = (s: string) => /^\s*https?:\/\/\S+\s*$/.test(s);
const trimUrl = (u: string) => u.replace(/[.,!?;:]+$/, "");

// ---- 1. No invented facts: every name, place, clock time, number and link is in the facts, the thread or their words.
// Words that are Cue's own world, not a claim about theirs.
const OWN = "Cue Noise iMessage";
export function inventedFacts(i: HardRuleInput): string[] {
  const given = [i.facts, ...i.theirLines, ...i.coLines, i.firstName ?? ""].join("\n");
  const src = { all: prepareSource(`${given}\n${SPOKEN_COMMON} ${OWN}`), asked: prepareSource(given) };
  const out: string[] = [];
  for (const s of sentencesOf(i.text.replace(URL_RE, " "))) {
    const p = spokenProblem(s, src);
    // A promise of later work is the product's own fact check's call (it reads the task list); here only names, times and numbers.
    if (p && p.kind !== "promise") out.push(`${p.kind === "number" ? "a number" : p.kind === "event" ? "an event detail" : "a name"} nothing gave it (${p.missing.join(", ")}): "${s.slice(0, 120)}"`);
  }
  const known = new Set((given.match(URL_RE) ?? []).map(trimUrl));
  for (const u of (i.text.match(URL_RE) ?? []).map(trimUrl)) if (!known.has(u) && !(i.findUrls ?? []).includes(u)) out.push(`a link nothing gave it: ${u}`);
  return out;
}

// ---- 2. No system-status talk on a check-in: presence and one item of their world, never a report on Cue's own state.
export const STATUS_TALK = [
  /\bnothing (?:is |'s )?(?:running|waiting|pending|queued|new|scheduled|in progress|on (?:my|your) (?:end|plate|radar|list))\b/i,
  /\bnothing (?:to report|from me|on my end|on my side)\b/i,
  /\bno (?:updates?|news) (?:from|on) (?:me|my end|my side)\b/i,
  /\bon your radar\b/i,
  /\ball (?:quiet|clear) (?:on|from|here)\b/i,
  /\b(?:status|quick) (?:update|report|check)\b/i,
  /\b(?:here'?s|quick) (?:where things stand|what'?s (?:going on|happening) (?:on my end|with me))\b/i,
];
export function statusTalk(text: string): string[] {
  return STATUS_TALK.flatMap((re) => { const m = norm(text).match(re); return m ? [`a status line on a check-in: "${m[0]}"`] : []; });
}

// ---- 3. No stock empathy: a phrase that fits any answer (harness/stockLines.ts), never a sentence that is only "Makes sense."
export function stockEmpathy(text: string): string[] {
  return sentencesOf(text).flatMap((s) => {
    const phrase = stockLine(s);
    if (phrase) return [`a stock phrase: "${phrase}"`];
    return textStockSentence(s) ? [`a stock sentence: "${s.slice(0, 60)}"`] : [];
  });
}

// ---- 4. No machinery narration: Cue never talks about its systems, tools, prompts, errors or retries (TOOL_FAILURE_RULE).
export const MACHINERY = [
  /\bon my (?:end|side)\b/i,
  /\bmy (?:systems?|pipeline|backend|queue|database|tools?|tooling|instructions|prompt|programming|training|context window|logs?)\b/i,
  /\b(?:the|a) (?:fact[- ]check|tool call|system prompt|language model)\b/i,
  /\bas an ai\b|\bi'?m (?:just )?an ai\b/i,
  /\b(?:the|my) (?:search|searches|lookup|tool) (?:returned|failed|errored|timed out|came back (?:empty|with nothing))\b/i,
  /\b(?:hit|got|ran into|threw) (?:an? )?(?:error|glitch|bug|timeout|rate limit)\b/i,
  /\b(?:retry|retrying|retried|try again later)\b/i,
];
export function machinery(text: string): string[] {
  return MACHINERY.flatMap((re) => { const m = norm(text).match(re); return m ? [`talks about its own machinery: "${m[0]}"`] : []; });
}

// ---- 5. No quoting its own earlier line back ("That deserved more than 'nice evening'"): a quoted span of 2+ words from what Cue sent.
export function quotesOwnLine(text: string, coLines: string[]): string[] {
  const t = norm(text);
  const spans = [...t.matchAll(/"([^"\n]{3,160})"/g), ...t.matchAll(/(?:^|[\s(])'([^'\n]{3,160})'(?=[\s.,!?;:)]|$)/g)].map((m) => m[1]);
  const theirs = coLines.map(words);
  return spans.filter((q) => words(q).split(" ").length >= 2 && theirs.some((l) => ` ${l} `.includes(` ${words(q)} `))).map((q) => `quotes its own earlier line back: "${q}"`);
}

// ---- 6. Link then caption: a find goes out as its link alone, then a caption that isn't a link; never inside prose.
export function linkThenCaption(sends: Send[], findUrls: string[]): string[] {
  const finds = new Set(findUrls.map(trimUrl));
  const isFind = (s: string) => bareUrl(s) && finds.has(trimUrl(s.trim()));
  const out: string[] = [];
  sends.forEach((s, i) => {
    if (isFind(s.text)) {
      const next = sends[i + 1]?.text ?? "";
      if (!next.trim() || bareUrl(next)) out.push(`a find's link with no caption after it: ${s.text.trim()}`);
    } else if ((s.text.match(URL_RE) ?? []).some((u) => finds.has(trimUrl(u)))) out.push(`a find's link inside prose (a find is its link, then a caption): "${s.text.slice(0, 120)}"`);
  });
  return out;
}

// ---- 7. One reply a turn: one sendReply text, unless a tool brought something new after it went out (TOOL_TURN_RULES).
const WORK_TOOLS = new Set(["searchEvents", "webSearch", "searchPosts", "readPage", "shareFinds", "researchBrief", "startTask", "writeDocument", "draftEmail", "emailPlan", "makePage", "makeDeck", "followUp", "moveLane", "readDocument"]);
export function repliesPerTurn(sends: Send[], tools: string[]): string[] {
  const replies = sends.filter((s) => s.kind === "reply" && s.text.trim());
  if (replies.length <= 1 || tools.some((t) => WORK_TOOLS.has(t))) return [];
  return [`${replies.length} replies in one turn: ${replies.map((r) => `"${r.text.slice(0, 50)}"`).join(" / ")}`];
}

// Every hard rule that applies to this turn. An empty reply (a tapback alone) has nothing to check.
export function hardRuleMisses(i: HardRuleInput): string[] {
  const sends = i.sends ?? (i.text.trim() ? [{ kind: "reply" as const, text: i.text }] : []);
  const prose = sends.filter((s) => !bareUrl(s.text)).map((s) => s.text).join("\n") || (sends.length ? "" : i.text);
  if (!prose.trim() && !sends.length) return [];
  return [
    ...inventedFacts({ ...i, text: sends.map((s) => s.text).join("\n") || i.text }),
    ...(i.kind === "checkin" ? statusTalk(prose) : []),
    ...stockEmpathy(prose),
    ...machinery(prose),
    ...quotesOwnLine(prose, i.coLines),
    ...linkThenCaption(sends, i.findUrls ?? []),
    ...repliesPerTurn(sends, i.tools ?? []),
  ];
}

// What kind of turn a message opens, when the case doesn't say: a check-in ("just checking in", a bare greeting), or the moment read.
const BARE_GREETING = /^\s*(?:hey|hi|hello|yo|morning|evening|good (?:morning|afternoon|evening))\b[\s,!.]*(?:(?:there|cue|co|you)\b[\s,!.]*)?$/i;
export function turnKind(message: string, moment?: string | null): TurnKind {
  if (/\bchecking in\b|\bcheck(?:ing)? in on you\b/i.test(message) || BARE_GREETING.test(message)) return "checkin";
  if (moment === "sharing") return "share";
  if (moment === "feedback") return "feedback";
  return "reply";
}
