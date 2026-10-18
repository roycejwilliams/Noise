// Punch is fine, invention is not (Royce, 2026-10-11), with the line redrawn the same evening ("A pitch deck's job is rhetoric"):
//   - positioning, framing, contrasts, taglines and rhetoric are punch, never invention;
//   - when they ask Co to figure out the positioning, that's an explicit grant to write it;
//   - a deck about Co itself (for the team): what Co knows about itself counts as fact;
//   - only verifiable hard claims they never made fail: partnerships, customer counts, numbers, named events, named people, and
//     (2026-10-12 intelligence audit) factual market or industry claims nothing they said or read backs ("Most retired EV
//     batteries are landfilled..."); a stance about the market is still rhetoric;
//   - elaborate is the bar: a full deck that passes beats a bare one; a risky line is rewritten safer, never gutted.
// One small model call judges every new line. The names, numbers and places check (grounding.ts deckProblems) runs regardless. If
// this check can't run (twice), the deck isn't made and Co says so: a deck never ships unchecked.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../../models.js";
import { parseModelJson } from "../modelJson.js";

export type Judge = (prompt: string) => Promise<string>;
const haiku: Judge = async (prompt) =>
  (await generateText({ model: anthropic(MODELS.haiku), experimental_telemetry: { isEnabled: true, functionId: "deck.claims" }, prompt, abortSignal: AbortSignal.timeout(20_000) })).text;

// The judge's verdict, one per line (K, Royce 2026-10-17: "per-line verdicts where stance lines can't fail, a code overrule for a
// 'missing name' that's in their words or goals"). The 5-replay "K before" measurement found the old one-shot answer (a free-text
// list of fails) refused the same deck on some reads and not others, and refused stance lines and the member's own name every time.
// So the judge now says, for every line, whether it's a stance or a fact and, for a fact their words don't give, what's missing.
// Code then decides: a stance never fails, and a missing name that is in their words, their own name or their goals is dropped.
// Temperature 0 was part of the plan; Haiku 5.5 rejects it ("temperature is deprecated for this model", checked 2026-10-17), so the
// call is unchanged.

// The kinds of fact a line can state. A fail of any other kind (or "stance") is read as a pass: stance can't fail.
export const FACT_KINDS = ["partnership", "count", "number", "date", "named_person", "named_company", "named_event", "result", "market_fact"] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export type LineVerdict = { n: number; verdict: "pass" | "fail"; kind: FactKind | "stance"; missing: string };
// The kinds a name decides: when the missing name is in their words, their own name or their goals, the fail is code's to drop.
const NAME_KINDS = new Set<string>(["named_person", "named_company", "named_event"]);
// How each kind reads in the error the writer gets back (G hands it to the writer, so it says what's missing, plainly).
const KIND_SAYS: Record<FactKind, string> = {
  partnership: "a partnership or deal",
  count: "a count",
  number: "a number, price or metric",
  date: "a day, time or year",
  named_person: "a person's name",
  named_company: "a company's name",
  named_event: "a named event",
  result: "a result or proof",
  market_fact: "a claim about the market",
};

// Pure: the prompt. theirWords: what they said for this deck (and what was read for it). self: what Cue knows about itself, when
// the deck is about Cue (else empty). thread: Cue's text directly before their latest message, and that message (approvalPair), so
// a line Cue proposed and they approved ("Ok create the doc", 2026-10-12 audit) is theirs; whether they approved it is the judge's
// read, never a word list. The judge gets only these and the deck's lines.
export function claimsPrompt(lines: string[], theirWords: string, self = "", thread = ""): string {
  return `A member asked for a slide deck. For each line on it, say whether it is a stance or a fact, and whether their words give it.

THEIR WORDS means the box below marked "What they said"${self ? ", and the box of what Cue knows about itself (this deck is about Cue)" : ""}. A fact counts as theirs when it is said there in any wording: rephrased, shortened or combined is fine.

A STANCE is how they present themselves, what they believe, or how they frame the offer. It can't be checked true or false. A stance always passes, even in words they never used. Example: "Not another social club".
A label ("The problem", "The ask") is a stance too.

A FACT is something that could be checked true or false. Example: "14 studios pay $89 a month". A fact passes when their words give it and fails when they don't. Its kind is one of:
- partnership: working with someone, a deal ("Partnering with X" when they only named X is a fail)
- count: how many people, customers, members or seats
- number: a price, metric, amount or share
- date: a day, time, month or year
- named_person, named_company, named_event: a name presented as a fact
- result: something proven, won, achieved or tested
- market_fact: how the market, industry or world is ("Demand is doubling"); a belief about it ("The next wave needs Y") is a stance
${thread ? `
Their approval of Cue's last text (below) makes a stance in it theirs. It never makes a fact theirs: names, numbers, partners, counts, dates and events must be in their own words. A Cue text they didn't clearly approve backs nothing.
` : ""}
What they said:
"""
${theirWords.slice(0, 6000)}
"""
${self ? `
What Cue knows about itself:
"""
${self.slice(0, 3000)}
"""
` : ""}${thread ? `
Cue's last text and their reply:
"""
${thread.slice(-3000)}
"""
` : ""}
Deck lines:
${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}

Return ONLY JSON, one entry for every line, in order:
{"lines": [{"n": 1, "verdict": "pass", "kind": "stance"}, {"n": 2, "verdict": "fail", "kind": "count", "missing": "30 members"}]}
"kind" is "stance" or one of the fact kinds. "missing" is, for a fail, the fact their words don't give, in a few words.`;
}

// Pure: the judge's answer read strictly, or null when it isn't one. It must give one entry for every line, each naming its line by
// its whole number, with a verdict and a kind: an answer that skips a line, or is in the old free-text shape, is an answer the check
// can't trust, so it is never read as a pass.
export function parseLineVerdicts(text: string, lineCount: number): LineVerdict[] | null {
  let out: unknown;
  try {
    out = parseModelJson<unknown>(text);
  } catch {
    return null;
  }
  const rows = (out as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(rows) || rows.length !== lineCount) return null;
  const seen = new Set<number>();
  const read: LineVerdict[] = [];
  for (const r of rows) {
    const o = (r ?? {}) as { n?: unknown; verdict?: unknown; kind?: unknown; missing?: unknown };
    const n = o.n;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > lineCount || seen.has(n)) return null;
    if (o.verdict !== "pass" && o.verdict !== "fail") return null;
    const kind = String(o.kind ?? "");
    if (kind !== "stance" && !(FACT_KINDS as readonly string[]).includes(kind)) return null;
    seen.add(n);
    read.push({ n, verdict: o.verdict, kind: kind as LineVerdict["kind"], missing: String(o.missing ?? "").trim().slice(0, 120) });
  }
  return read.sort((a, b) => a.n - b.n);
}

// Pure: a name is "there" when its words appear, in order, in their words, their own name or their goals (case and punctuation aside).
const plain = (s: string) => ` ${s.toLowerCase().replace(/[’']s\b/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;
export function nameIsTheirs(missing: string, hay: string): boolean {
  const m = plain(missing.replace(/^["“]|["”]$/g, ""));
  return m.trim().length > 1 && plain(hay).includes(m);
}

// Pure: what code makes of the verdicts. A fail stands only when it's a fact (stance can't fail) and, for a name, the name isn't in
// their words, their own name or their goals (known). Each one that stands says which line and what's missing.
export function standingFails(lines: string[], verdicts: LineVerdict[], theirWords: string, known = ""): { line: string; why: string }[] {
  const hay = `${theirWords}\n${known}`;
  return verdicts
    .filter((v) => v.verdict === "fail" && v.kind !== "stance")
    .filter((v) => !(NAME_KINDS.has(v.kind) && v.missing && nameIsTheirs(v.missing, hay)))
    .map((v) => ({ line: lines[v.n - 1], why: `${KIND_SAYS[v.kind as FactKind]} their words don't give${v.missing ? `: ${v.missing}` : ""}` }));
}

// Pure: what the name overrule reads besides their words: their own first name and the goals they're working toward (active only;
// a done or set-aside goal is history).
export function knownFor(o: { firstName?: string | null; goals?: { text: string; state: string }[] }): string {
  return [o.firstName ?? "", ...(o.goals ?? []).filter((g) => g.state === "active").map((g) => g.text)].map((s) => s.trim()).filter(Boolean).join("\n");
}

// The lines that add a claim, or null when the check couldn't run.
// Tried twice before giving up (PR 6: on a call the check timed out and, failing open, let "no free tier, no trials" onto a deck).
// An answer that doesn't read (parseLineVerdicts) counts as the check not running: tried again, then null, and the caller makes
// nothing. known: their own name and their goals, read only by the name overrule (the judge doesn't see it).
export async function inventedLines(lines: string[], theirWords: string, judge: Judge = haiku, self = "", thread = "", known = ""): Promise<{ line: string; why: string }[] | null> {
  if (!lines.length) return [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const verdicts = parseLineVerdicts(await judge(claimsPrompt(lines, theirWords, self, thread)), lines.length);
      if (!verdicts) continue;
      return standingFails(lines, verdicts, [theirWords, self].filter(Boolean).join("\n"), known);
    } catch {
      continue;
    }
  }
  return null;
}

// Pure: every line of a deck the check reads (the title is a name; the subtitle, headlines and bullets are claims).
export function deckClaimLines(d: { subtitle: string; slides: { headline: string; bullets: string[]; notes?: string }[] }): string[] {
  return [d.subtitle, ...d.slides.flatMap((s) => [s.headline, ...s.bullets, ...(s.notes ? [s.notes] : [])])];
}

// What Co knows about itself, for a deck the team makes about Co: who Co is (the opening of its own prompt,
// prompts/co-system-prompt.md) and what it can do (the capability sheet). Facts from Co's own code, never from a member.
export const CO_IS = "Cue gets to know people over time and brings the right people and moments into their lives. Noise is invite-only: being here means something. Cue is a genuine, ongoing companion, by text and by phone call.";
export async function coSelfKnowledge(): Promise<string> {
  const { capabilitySheet } = await import("../capabilities.js");
  return [CO_IS, ...capabilitySheet()].join("\n");
}

// Pure: Co's text directly before their latest message, and that message, as "Co: …\nThem: …"; "" when their latest message
// doesn't follow a Co text. Only that one Co text can be approved by their reply (2026-10-12 review: "ok make the deck" approving
// everything in Co's last 8 texts risked an invented fact or another member's name on a shareable deck). rows: oldest first.
export function approvalPair(rows: string[]): string {
  const last = rows[rows.length - 1];
  if (!last?.startsWith("Them: ")) return "";
  let i = rows.length - 2;
  while (i >= 0 && rows[i].startsWith("Them: ")) i--;
  if (i < 0 || !/^(?:Co|Cue): /.test(rows[i])) return "";
  // Their texts between that Co text and the latest are part of the reply.
  return [rows[i], ...rows.slice(i + 1)].join("\n");
}
