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
import { numbersOf } from "../offerGuard.js";
import { COMMON, sameTimes } from "./grounding.js";

export type Judge = (prompt: string) => Promise<string>;
const haiku: Judge = async (prompt) =>
  (await generateText({ model: anthropic(MODELS.haiku), experimental_telemetry: { isEnabled: true, functionId: "deck.claims" }, prompt, abortSignal: AbortSignal.timeout(20_000) })).text;

// The judge's verdict, one per line (K, Royce 2026-10-17: "per-line verdicts where stance lines can't fail, a code overrule for a
// 'missing name' that's in their words or goals"). The 5-replay "K before" measurement found the old one-shot answer (a free-text
// list of fails) refused the same deck on some reads and not others, and refused stance lines and the member's own name every time.
// So the judge now says, for every line, pass or fail and, for a fail, every fact on that line their words don't give (its kind and
// what's missing). Code then decides, and guards facts, not the judge's labels (review of #240):
//   - a fail the judge calls a stance passes, unless the line carries a figure their words don't (a number, %, $, a count, a date, a
//     month, a weekday or a time): a mislabelled "30% off" still refuses;
//   - a missing name is dropped only when it is the member's own first name and stands in the line (Royce, 2026-10-17: "Names the
//     code may clear: the member's own first name only"), and never on a line that also carries an unbacked figure or a relationship
//     word (partner, sponsor, backed, co-host, investor, advisor, confirmed...). Any other name, even one in their words or goals, is
//     the judge's to decide;
//   - a line is refused unless every fact the judge listed on it is cleared.
// Temperature 0 was part of the plan; Haiku 5.5 rejects it ("temperature is deprecated for this model", checked 2026-10-17), so the
// call is unchanged.

// The kinds of fact a line can state. "stance" is accepted in a fact list and read as no fact (unless a figure says otherwise).
export const FACT_KINDS = ["partnership", "count", "number", "date", "named_person", "named_company", "named_event", "result", "market_fact"] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export type Fact = { kind: FactKind | "stance"; missing: string };
export type LineVerdict = { n: number; verdict: "pass" | "fail"; facts: Fact[] };
// The kinds a name decides: when the missing name is the member's own first name, the fail is code's to drop.
const NAME_KINDS = new Set<string>(["named_person", "named_company", "named_event"]);
// How each kind reads in the error the writer gets back (G hands it to the writer, so it says what's missing, plainly).
const KIND_SAYS: Record<FactKind | "stance", string> = {
  partnership: "a partnership or deal",
  count: "a count",
  number: "a number, price or metric",
  date: "a day, time or year",
  named_person: "a person's name",
  named_company: "a company's name",
  named_event: "a named event",
  result: "a result or proof",
  market_fact: "a claim about the market",
  stance: "a figure",
};

// Pure: the prompt. theirWords: what they said for this deck (and what was read for it). self: what Cue knows about itself, when
// the deck is about Cue (else empty). thread: Cue's text directly before their latest message, and that message (approvalPair), so
// a line Cue proposed and they approved ("Ok create the doc", 2026-10-12 audit) is theirs; whether they approved it is the judge's
// read, never a word list. The judge gets only these and the deck's lines.
export function claimsPrompt(lines: string[], theirWords: string, self = "", thread = ""): string {
  return `A member asked for a slide deck. For each line on it, say whether it passes or fails.

THEIR WORDS means the box below marked "What they said"${self ? ", and the box of what Cue knows about itself (this deck is about Cue)" : ""}. A fact counts as theirs when it is said there in any wording: rephrased, shortened or combined is fine.

A STANCE is how they present themselves, what they believe, or how they frame the offer. It can't be checked true or false. A stance always passes, even in words they never used. Example: "Not another social club".
A label ("The problem", "The ask") is a stance too.

A FACT is something that could be checked true or false. Example: "14 studios pay $89 a month". A fact passes when their words give it and fails when they don't. A line fails when any fact on it isn't in their words. The kinds of fact:
- partnership: working with someone, a deal, a sponsor, a backer, a co-host, an investor ("Partnering with X" when they only named X is a fail)
- count: how many people, customers, members or seats
- number: a price, metric, amount or share
- date: a day, time, month or year
- named_person, named_company, named_event: a name presented as a fact
- result: something proven, won, achieved, confirmed or tested
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

Return ONLY JSON, one entry for every line, in order. For a fail, list every fact on that line their words don't give, each with its kind and what's missing in a few words:
{"lines": [{"n": 1, "verdict": "pass"}, {"n": 2, "verdict": "fail", "facts": [{"kind": "count", "missing": "30 members"}, {"kind": "named_company", "missing": "Blue Bottle"}]}]}`;
}

// Pure: the judge's answer read strictly, or null when it isn't one. It must give one entry for every line, each naming its line by
// its whole number, with a verdict; a fail must list at least one fact, each of a known kind. An answer that skips a line, carries the
// old free-text "fails" list (alone or beside "lines"), or has an unknown kind is an answer the check can't trust: never a pass.
export function parseLineVerdicts(text: string, lineCount: number): LineVerdict[] | null {
  let out: unknown;
  try {
    out = parseModelJson<unknown>(text);
  } catch {
    return null;
  }
  if (!out || typeof out !== "object" || Array.isArray(out) || "fails" in (out as object)) return null;
  const rows = (out as { lines?: unknown }).lines;
  if (!Array.isArray(rows) || rows.length !== lineCount) return null;
  const seen = new Set<number>();
  const read: LineVerdict[] = [];
  for (const r of rows) {
    const o = (r ?? {}) as { n?: unknown; verdict?: unknown; facts?: unknown };
    const n = o.n;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > lineCount || seen.has(n)) return null;
    if (o.verdict !== "pass" && o.verdict !== "fail") return null;
    const facts: Fact[] = [];
    if (o.facts !== undefined && !Array.isArray(o.facts)) return null;
    for (const f of (o.facts ?? []) as unknown[]) {
      const kind = String((f as { kind?: unknown } | null)?.kind ?? "");
      if (kind !== "stance" && !(FACT_KINDS as readonly string[]).includes(kind)) return null;
      facts.push({ kind: kind as Fact["kind"], missing: String((f as { missing?: unknown }).missing ?? "").trim().slice(0, 120) });
    }
    if (o.verdict === "fail" && !facts.length) return null;
    seen.add(n);
    read.push({ n, verdict: o.verdict, facts });
  }
  return read.sort((a, b) => a.n - b.n);
}

// Pure: a phrase is "in" a text when its words appear there whole and in order (case, punctuation and a possessive aside).
const plain = (s: string) => ` ${s.toLowerCase().replace(/[’']s\b/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;
const inText = (phrase: string, text: string) => {
  const p = plain(phrase.replace(/^["“]|["”]$/g, ""));
  return p.trim().length >= 3 && plain(text).includes(p);
};
// Pure: a missing name appears in what they said (their words, own name, goals) and in the deck line itself, as whole words and 3+
// characters. It only picks the wording of a refusal; it never clears one (only their own first name does).
export function nameIsTheirs(missing: string, hay: string, line?: string): boolean {
  if (line !== undefined && !inText(missing, line)) return false;
  return inText(missing, hay);
}

// Pure: the figures in a line their words don't give: numbers (with %, $, k), number words from two up, "thousands",
// "hundreds", "a million", "dozens", months, weekdays and noon or midnight. Times and dates are put the same way on both sides first
// (grounding.ts sameTimes), so "7pm" matches "7:00 PM", and a short month followed by a day ("Nov 14") is the full month. A month is
// matched by its case in their words ("you may want" never backs "Launch party in May").
const MONTH_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/g;
const WEEKDAY_RE = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)s?\b/gi;
const CLOCK_WORDS = /\b(noon|midday|midnight)\b/gi;
const AMOUNT_WORDS = /\b(thousands?|hundreds|millions?|billions?|dozens)\b/gi;
export function unbackedFigures(line: string, theirWords: string): string[] {
  const l = sameTimes(line);
  const t = sameTimes(theirWords, "theirs");
  const theirNums = numbersOf(t, true);
  // "one" is how a stance talks ("one table", "one idea"); a digit 1 is still a figure.
  const digits = numbersOf(l);
  const nums = [...numbersOf(l, true)].filter((n) => (n !== "1" || digits.has("1")) && !theirNums.has(n));
  const months = (l.match(MONTH_RE) ?? []).filter((m) => !new RegExp(`\\b${m}\\b`).test(t));
  const other = [...(l.match(WEEKDAY_RE) ?? []).map((w) => w.replace(/s$/i, "")), ...(l.match(CLOCK_WORDS) ?? []), ...(l.match(AMOUNT_WORDS) ?? [])].filter((w) => !new RegExp(`\\b${w}`, "i").test(t));
  return [...new Set([...nums, ...months, ...other])];
}
// A relationship or commitment word: a name on a line with one of these is a claim about that name, never just the name (reviews of
// #240: "Hosted by", "Powered by", "Featuring", "Alongside", "our first client", "loves it", "is in", "says yes"...). Whether the word
// is also in their words never clears it: the judge reads the claim, code only refuses to wave it through.
const CLAIM_WORDS = new RegExp(
  [
    "partner(?:s|ed|ing|ship|ships)?", "sponsor(?:s|ed|ing|ship|ships)?", "back(?:ed|ing|er|ers)", "co-?host(?:s|ed|ing)?", "team(?:ed|ing)? up",
    "invest(?:or|ors|ed|ing|ment|ments)?", "fund(?:ed|ing|er|ers)", "advis(?:or|ors|er|ers|ed|ing)", "mentor(?:s|ed|ing)?", "confirm(?:ed|s)?",
    "signed", "approved", "committed", "deals? with", "(?:has )?joined", "collaborat\\w*", "joins", "featur(?:ing|ed|es)", "alongside",
    "on ?board", "clients?", "customers?", "members?", "official\\w*", "acquir\\w*", "lov(?:e|es|ed)", "is in", "says? yes",
    "(?:party|launch|night|night out|dinner|supper|drinks|brunch|lunch|breakfast|evening|event) with",
    "(?:hosted|presented|powered|supported|trusted|used|endorsed|joined|led|run|curated|organi[sz]ed|produced|built|chosen|loved|recommended|certified|verified|sponsored|backed|funded|mentored|advised) (?:by|with)",
  ].map((w) => `\\b${w}\\b`).join("|"),
  "i",
);
// What code reads besides their words (knownFor): their own first name, the only name code may clear (Royce, 2026-10-17: "Names the
// code may clear: the member's own first name only"; no nickname is kept on record today). Their active goals ride along for the
// wording of a refusal only: a goal is an aim, so it backs neither a name nor a figure ("40 members by March" never backs "40 members").
export type Known = { text: string; firstName: string | null };
const knownOf = (k: Known | string): Known => (typeof k === "string" ? { text: k, firstName: null } : k);
// The one relationship form their own name may carry: "Hosted by Odile" is them hosting, so the hosting words never count as a claim.
// A co-host can't slip through it: their own name clears only on a line with no other name on it (otherNameOn).
const HOSTING = /^hosted (?:by|with)$/i;
const isOwnName = (missing: string, firstName: string | null) => !!firstName && plain(missing).trim().length > 0 && plain(missing) === plain(firstName);
const ownNameInLine = (firstName: string | null, line: string) => !!firstName && plain(firstName).trim().length > 0 && plain(line).includes(plain(firstName));
// Pure: another name on the line. Any capitalized word (each part of a hyphenated one) counts, unless it is their own first name (or its
// possessive, any case), a common word (grounding.ts COMMON), "I", or a hosting word. Simple on purpose (review of #240): "Odile and
// Acme host", "Odile Martin cooks", "Odile-Marie cooks", "ex-Google" all carry another name.
const HOST_TOKENS = new Set(["hosted", "host", "hosts", "hosting", "by", "with"]);
export function otherNameOn(line: string, firstName: string | null): boolean {
  const own = (firstName ?? "").trim().toLowerCase();
  for (const raw of line.split(/[\s,.;:!?()"“”/+&\-–—]+/)) {
    const w = raw.replace(/^['‘’]+|['‘’]+$/g, "");
    if (!/^[A-Z]/.test(w)) continue;
    const base = w.replace(/['’]s$/i, "").toLowerCase();
    if ((own && base === own) || COMMON.has(base) || HOST_TOKENS.has(base) || base === "i" || /^i['’]/.test(base)) continue;
    return true;
  }
  return false;
}

// Pure: what code makes of the verdicts. A failed line stands unless every fact listed on it is cleared: a stance (no unbacked figure
// on the line), or a missing name that is their own first name (in the line; no unbacked figure or relationship word on it). A name in
// their words or goals is never cleared by code: the judge decides it. Each line that stands says what's missing, so it can go back to
// the writer.
export function standingFails(lines: string[], verdicts: LineVerdict[], theirWords: string, known: Known | string = ""): { line: string; why: string }[] {
  const k = knownOf(known);
  const hay = `${theirWords}\n${k.firstName ?? ""}\n${k.text}`;
  const out: { line: string; why: string }[] = [];
  for (const v of verdicts) {
    if (v.verdict !== "fail") continue;
    const line = lines[v.n - 1];
    // Figures are backed by their words only: a goal is an aim (a figure from it would read as done), and their own name backs none.
    const figures = unbackedFigures(line, theirWords);
    // "Hosted by/with" is never the claim: their own name clears only on a line with no other name anyway.
    const claimWord = [...line.matchAll(new RegExp(CLAIM_WORDS.source, "gi"))].map((m) => m[0]).find((w) => !HOSTING.test(w));
    const claimy = figures.length > 0 || !!claimWord;
    const standing = v.facts.filter((f) => {
      if (f.kind === "stance") return figures.length > 0;
      if (NAME_KINDS.has(f.kind) && !claimy && isOwnName(f.missing, k.firstName) && ownNameInLine(k.firstName, line) && !otherNameOn(line, k.firstName)) return false;
      return true;
    });
    if (!standing.length) continue;
    // A name they did give that stands only because of what the line says about it is said that way, so the writer fixes the claim.
    const says = standing.map((f) =>
      f.kind === "stance"
        ? `a figure their words don't give: ${figures.join(", ")}`
        : NAME_KINDS.has(f.kind) && isOwnName(f.missing, k.firstName) && !claimy && otherNameOn(line, k.firstName)
          ? `their own name, ${f.missing}, is on a line that names someone else too; write it without the other name, or check that name with them`
          : NAME_KINDS.has(f.kind) && f.missing && nameIsTheirs(f.missing, hay, line) && claimy
          ? `this line says more about ${f.missing} than their words do (${[claimWord, ...figures].filter(Boolean).join(", ")}); write the name without the claim`
          : NAME_KINDS.has(f.kind) && f.missing && nameIsTheirs(f.missing, hay, line)
            ? `${KIND_SAYS[f.kind]} read as a fact their words don't give: ${f.missing}; name it the way they did, or leave it out`
          : `${KIND_SAYS[f.kind]} their words don't give${f.missing ? `: ${f.missing}` : ""}`,
    );
    out.push({ line, why: says.join("; ") });
  }
  return out;
}

// Pure: their own first name (the only name code may clear) and their active goals (used only to word a refusal: a goal backs neither a
// name nor a figure); a done or set-aside goal is history.
export function knownFor(o: { firstName?: string | null; goals?: { text: string; state: string }[] }): Known {
  return { firstName: o.firstName?.trim() || null, text: (o.goals ?? []).filter((g) => g.state === "active").map((g) => g.text.trim()).filter(Boolean).join("\n") };
}

// The lines that add a claim, or null when the check couldn't run.
// Tried twice before giving up (PR 6: on a call the check timed out and, failing open, let "no free tier, no trials" onto a deck).
// An answer that doesn't read (parseLineVerdicts) counts as the check not running: tried again, then null, and the caller makes
// nothing. known: their own first name (the only name code may clear) and their goals (wording only); the judge doesn't see them.
export async function inventedLines(lines: string[], theirWords: string, judge: Judge = haiku, self = "", thread = "", known: Known | string = ""): Promise<{ line: string; why: string }[] | null> {
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
