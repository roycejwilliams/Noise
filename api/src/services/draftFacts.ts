// A draft that speaks for the member is checked against what backs it before they see it (Royce, 2026-10-27: Cue checks its work
// first; the member isn't QA for a wrong date or headcount). Used by draftEmail (agent/loopTools.ts).
//
// 2026-10-28, Royce: meaning-based, against the original evidence ("(a)"). The regex comparison it replaces failed both ways in
// review: it refused "7pm" for "dinner at 7", "Wednesday, October 28" for "tomorrow", "$1,200.00", "for eight", "nyc", a reformatted
// phone; and it passed "in the Marina" from an SF allowlist, "30 guests" from "I'm turning 30", an "11pm" from a venue's hours, a
// headcount from an ISO date, any "fri..." word for a Friday. So one small Haiku call reads the draft beside the original sources
// and names each specific detail they don't establish, in the draft's own words. "'7' only becomes '7pm' if PM is actually
// established": the rules below say when, the same way every time, and the checker never adds or fixes a detail itself; it only
// reports, and draftEmail refuses the draft with those words named, as before.
//
// The evidence is the original sources only: their own words verbatim (this message, and two weeks of their texts and their side of
// calls, each dated so a "tomorrow" said last week reads from that day), their own name and contact on file, and what Cue read
// (pages read this turn, and finds' own facts). Never Cue's brief or notes: that's Cue's own extraction and can't back itself.
// Every source is keyed to this member (ctx.userId) by the caller; nothing here reads the database.
//
// Their own phone and email go in as evidence, labelled as theirs, instead of being cut out of the draft first: the cut swallowed an
// invented number written just before the phone (review of #286), and labelled as contact details they back only contact details.
//
// Fail safe (decided 2026-10-28): when the call fails, times out or comes back malformed, the draft goes to them unchecked and the
// check is recorded as not run (draftEmail logs it; never "checked"). A blocked draft costs the member the help outright; an
// unchecked one is still theirs to read before they send it, and nothing goes anywhere unless they send it.
import { anthropic } from "@ai-sdk/anthropic";
import { DateTime } from "luxon";
import { z } from "zod";
import { MODELS } from "../models.js";

export const DRAFT_FACTS_SCHEMA = z.object({
  unestablished: z.array(
    z.object({
      words: z.string(),
      kind: z.enum(["count", "time", "date", "place", "price", "name", "contact", "other"]),
      why: z.string(),
    }),
  ),
});
export type DraftFactsAnswer = z.infer<typeof DRAFT_FACTS_SCHEMA>;
export type DraftGap = { words: string; kind: string; why: string };

// What backs a draft, every part this member's own (the caller keys each to ctx.userId).
export type DraftEvidence = {
  thisTurn: string; // their message this turn, verbatim
  earlier: string; // their texts and their side of calls, last two weeks, oldest first, each opening "[Tue Oct 27] "
  own: { name?: string | null; phone?: string | null; email?: string | null }; // on their account
  read: string[]; // pages read this turn, then finds' own facts, as they were
};

// How much evidence one check reads (sized 2026-10-28; see the PR for the cost). Their words this turn come first and whole; earlier
// texts keep the newest; pages come before finds, each source cut at its own limit so one long page can't crowd out the rest.
export const DRAFT_EVIDENCE_LIMITS = { thisTurn: 4_000, earlier: 12_000, perSource: 12_000, read: 36_000, draft: 6_000 } as const;

const newest = (t: string, n: number) => {
  if (t.length <= n) return t;
  const cut = t.slice(-n);
  const nl = cut.indexOf("\n");
  return nl >= 0 && nl < 400 ? cut.slice(nl + 1) : cut;
};

// Pure: the evidence as it goes in, within the limits.
export function boundEvidence(e: DraftEvidence): DraftEvidence {
  const L = DRAFT_EVIDENCE_LIMITS;
  const read: string[] = [];
  let left: number = L.read;
  for (const s of e.read) {
    const t = String(s ?? "").trim().slice(0, L.perSource);
    if (!t || left <= 0) continue;
    read.push(t.slice(0, left));
    left -= t.length;
  }
  return { thisTurn: String(e.thisTurn ?? "").slice(0, L.thisTurn), earlier: newest(String(e.earlier ?? ""), L.earlier), own: e.own ?? {}, read };
}

// Pure: their calendar around today (two weeks back, for dated texts; two months ahead, for the draft's dates), so a weekday is read
// off a list rather than worked out.
export function calendarLines(now: Date, zone: string): string {
  const today = DateTime.fromJSDate(now).setZone(zone).startOf("day");
  const days: string[] = [];
  for (let i = -14; i <= 62; i++) {
    const d = today.plus({ days: i });
    days.push(`${d.toFormat("ccc LLL d yyyy")}${i === 0 ? " (today)" : ""}`);
  }
  return days.join("; ");
}

// Pure: the prompt. Internal (never shown to a member).
export function draftFactsPrompt(draft: string, evidence: DraftEvidence, now: Date, zone: string): string {
  const e = boundEvidence(evidence);
  const today = DateTime.fromJSDate(now).setZone(zone);
  const own = [e.own.name ? `name: ${e.own.name}` : "", e.own.phone ? `phone: ${e.own.phone}` : "", e.own.email ? `email: ${e.own.email}` : ""].filter(Boolean).join("; ") || "(none on file)";
  return `You check an email draft that Cue, an assistant, wrote for a member to send in their own name. It speaks for them, so every specific detail in it must be established by the evidence below: what the member said, their own details on file, and what Cue read on pages or found. Your only job is to report the details that are not established. Never fix a detail, fill one in, or say what it should be.

Today is ${today.toFormat("cccc, LLLL d, yyyy")} in the member's time zone (${zone}).

Specific details: a count or headcount, a time of day, a date or weekday, a duration, a place (a city, neighborhood, venue, address, or "near" somewhere), a price, budget or amount, a person's or business's name, a phone number, email or link, and any other number. Not details: greetings, thanks, the form of the sign-off, general wording ("a private room", "a small group", "sometime soon"), a question that asks without asserting ("what times do you have?"), and a blank left for them to fill ("[date]").

A detail is established only when the evidence says it, or it follows from the evidence with no added assumption. Apply these rules the same way every time:
1. Same value, other form, is established: "eight" is 8; "$1,200" is "$1,200.00"; "7pm" is "7:00 PM" or "7 in the evening"; "(415) 555-0123" is "+14155550123"; "nyc" is New York; "sf" is San Francisco; "8 of us" is "a party of 8" or "8 guests".
2. Times and am/pm: a bare time ("at 7", "7:30") establishes the hour, never the part of the day. The draft's "pm", "am", "evening", "morning", "tonight" or a 24-hour time is established only when the evidence itself ties that time to that part of the day: it says am or pm, or the same text places it ("dinner at 7", "7 tonight", "drinks at 6 after work", "breakfast at 8", "lunch at 1"). Nothing else establishes it: not what is usual, not a venue's hours, not what seems likely. "Dinner at 7" establishes 7pm; "at 7" alone does not.
3. Dates and weekdays: each earlier text opens with the day they sent it, like [Tue Oct 27]. A relative day ("tomorrow", "Saturday", "this Friday") points to a date counted from the day that text was sent; their message this turn was sent today. Read weekdays and dates off the calendar below, never work them out. The draft's date and weekday are established only if they are the day the evidence points to. A date the evidence gives establishes that date's weekday and its year in the calendar. When the evidence could point to more than one day ("next Friday" said on a Wednesday), a single date in the draft is not established. The day marks and the calendar are not things they said: they only resolve dates.
4. Same thing, not just the same number or word: a value establishes only the thing it describes in the evidence. "I'm turning 30" does not establish 30 guests. A venue's "open 5pm to 11pm" establishes its hours, not when the member arrives or leaves. A date, phone number, address or price never establishes a headcount or a time. A budget of $500 does not establish a $500 deposit.
5. Places: a place is established when the evidence names it, or a standard short form of it (rule 1). A neighborhood, a nearby place or a wider area the evidence doesn't name is not established, even where the venue probably is. A venue's address or neighborhood on its own page establishes where that venue is.
6. Their own name, phone and email on file are established as their name and contact details, and as nothing else.
7. A request is still a detail: "Could we book for 12 on Saturday?" states 12 people and Saturday as theirs.
8. When you are not sure a detail follows with no added assumption, it is not established.

Report each unestablished detail once. "words" is the draft's exact words for just that detail ("7pm", "in the Marina", "12 people"), not the whole sentence. "why" says in a few words what the evidence lacks ("they said 7, never pm"), never what the value should be. If every detail is established, return an empty list.

Calendar (${zone}): ${calendarLines(now, zone)}

Their message this turn (sent today):
"""
${e.thisTurn.trim() || "(none)"}
"""

Their earlier texts and their side of calls, last two weeks, oldest first:
"""
${e.earlier.trim() || "(none)"}
"""

Their own details on file: ${own}

What Cue read or found (pages and finds, as they were):
"""
${e.read.length ? e.read.join("\n---\n") : "(nothing)"}
"""

The draft:
"""
${String(draft ?? "").slice(0, DRAFT_EVIDENCE_LIMITS.draft)}
"""`;
}

export type DraftFactsJudge = (prompt: string) => Promise<DraftFactsAnswer>;
// One Haiku call, held to the schema at the API (services/structuredJudge.ts). Its tokens are written to llm_usage under
// "draft.facts" by the telemetry span (services/llmUsage.ts), for the member whose scope the reply runs in.
export const haikuDraftFactsJudge: DraftFactsJudge = async (prompt) => {
  const { judgeJson } = await import("./structuredJudge.js");
  return (
    await judgeJson(DRAFT_FACTS_SCHEMA, {
      model: anthropic(MODELS.haiku),
      maxOutputTokens: 600,
      experimental_telemetry: { isEnabled: true, functionId: "draft.facts" },
      prompt,
      abortSignal: AbortSignal.timeout(15_000),
    })
  ).output;
};

// Layer 1 tests put a stub here (evals/review/drafts.ts); null in the app.
let judgeForTest: DraftFactsJudge | null = null;
export function setDraftFactsJudgeForTest(j: DraftFactsJudge | null): void {
  judgeForTest = j;
}

export type DraftCheck = { ran: true; gaps: DraftGap[] } | { ran: false; error: string };
// The check. ran: false when the judge couldn't answer: the caller lets the draft go and records that it wasn't checked. Every
// finding the judge returns is enforced as it said it (deduped, at most eight); code never vetoes one.
export async function checkDraftFacts(draft: string, evidence: DraftEvidence, now: Date, zone: string, judge: DraftFactsJudge = judgeForTest ?? haikuDraftFactsJudge): Promise<DraftCheck> {
  let answer: DraftFactsAnswer;
  try {
    answer = await judge(draftFactsPrompt(draft, evidence, now, zone));
  } catch (err: any) {
    return { ran: false, error: String(err?.message ?? err).slice(0, 200) };
  }
  if (!answer || !Array.isArray(answer.unestablished)) return { ran: false, error: "no answer in the expected shape" };
  const seen = new Set<string>();
  const gaps: DraftGap[] = [];
  for (const g of answer.unestablished) {
    const words = String(g?.words ?? "").trim().slice(0, 120);
    if (!words || seen.has(words.toLowerCase())) continue;
    seen.add(words.toLowerCase());
    gaps.push({ words, kind: String(g?.kind ?? "other"), why: String(g?.why ?? "").trim().slice(0, 100) });
  }
  return { ran: true, gaps: gaps.slice(0, 8) };
}
