// Open threads (Royce, 2026-09-22: "Make Co a true companion by giving it one
// thread through everything"). The few things a member is in the middle of,
// in their own words: the pitch on Friday, whether the block party draws
// enough people, the cofounder they're deciding on. Each thread carries a
// status, the feeling they had about it (from the life emotion signals), a
// date if they gave one, and what Co could do next.
//
// Everything that reaches out between conversations reads from here: the
// companion check-in picks one thread, a date they gave for something they
// said they'd do becomes a follow-up (the window_followup type), and the
// weekly reflection looks across them.
//
// Gates, in code (the model only proposes):
//   - a thread opens only with a quote of their own words (never Co's lines);
//   - it closes (resolved or changed) only with a newer quote of theirs;
//   - a date is parsed from their words by the same rules as a search's time
//     frame (services/askWindow.ts), never taken from the model;
//   - staleness only ever moves a thread to "waiting", never closed.
// Read only with the owner's user id; nothing here ever goes to another member.
import { notToTeammate } from "../services/teamLines.js";
import { stampOf } from "../services/factLabels.js";
import { sameThing } from "../services/whatCoKnows.js";
import { closeSaysHowItLanded } from "../services/milestones.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import { parseAskWindow } from "../services/askWindow.js";
import { localStamp, memberZone, wordsZone } from "../services/memberTime.js";
import { recordDecision, type GateCheck } from "./core.js";
import { enqueueCandidate, nextLocalHour } from "./proactive.js";
import type { WindowFollowUpPayload } from "../agent/windowFollowUp.js";
import { withMember } from "../services/llmUsage.js";

export type ThreadStatus = "open" | "waiting" | "resolved" | "changed";
export type NextStep = "check_in" | "look_up" | "remember" | "suggest_someone";
export const NEXT_STEPS: NextStep[] = ["check_in", "look_up", "remember", "suggest_someone"];

export type MemberThread = {
  id: string;
  text: string;
  openedQuote: string;
  openedAt: string;
  status: ThreadStatus;
  feeling: string | null;
  dueDate: string | null; // YYYY-MM-DD, their day
  nextStep: NextStep;
  kind: "thread" | "commitment";
  closedQuote: string | null;
  lastTouchedAt: string;
  // A transition is a thread about a life change (a move, a new role, going solo, starting over, a breakup, a new city, a career
  // pivot). null = an ordinary thread. "said": they said it outright; "inferred": read from what they said. The quote that opened it
  // is theirs either way (the gate). transitionChannel: where they said it. Picture Memory spec step 2 (2026-11-05).
  transition: TransitionSource | null;
  transitionChannel: LineVia | null;
};

export type TransitionSource = "said" | "inferred";
export type LineVia = "text" | "call";

// A line the member said, with when. Text replies come from "User said:"
// memories; calls from the "user:" lines of the stored transcript. Co's own
// lines and call summaries never count as their words.
export type OwnLine = { at: string; text: string; via?: LineVia };

const MAX_OPEN = 6;
const LOOKBACK_DAYS = 14;
// Untouched this long → "waiting" (still theirs, just quiet).
export const WAITING_AFTER_DAYS = 10;

export function squash(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

// Split a stored call transcript into the member's own lines.
export function userLinesFromTranscript(transcript: string): string[] {
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const raw of transcript.split("\n")) {
    const m = raw.match(/^\s*(user|assistant)\s*:\s*(.*)$/i);
    if (m) {
      if (cur) out.push(cur.join(" ").trim());
      cur = m[1].toLowerCase() === "user" ? [m[2]] : null;
    } else if (cur) {
      cur.push(raw);
    }
  }
  if (cur) out.push(cur.join(" ").trim());
  return out.filter(Boolean);
}

function tokens(s: string): Set<string> {
  return new Set(
    squash(s)
      .replace(/[^a-z0-9' ]/g, " ")
      .split(" ")
      .map((w) => w.replace(/^'+|'+$/g, ""))
      .filter((w) => w.length > 3),
  );
}

// Calls are transcribed as spoken ("october tenth"); the date rules read
// digits ("october 10"), so spoken day numbers are turned into digits first.
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};
export function spokenDayToDigits(s: string): string {
  return s
    .replace(/\b(twenty|thirty)[- ](first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\b/gi, (_, t: string, o: string) =>
      String((t.toLowerCase() === "twenty" ? 20 : 30) + ORDINALS[o.toLowerCase()]),
    )
    .replace(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)\b/gi, (w: string) =>
      String(ORDINALS[w.toLowerCase()]),
    );
}

export function overlap(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

// The newest of their lines that contains the quote, or null.
export function findQuote(quote: string, lines: OwnLine[]): OwnLine | null {
  const q = squash(quote ?? "");
  if (q.split(" ").filter(Boolean).length < 3) return null;
  let hit: OwnLine | null = null;
  for (const l of lines) if (squash(l.text).includes(q) && (!hit || l.at > hit.at)) hit = l;
  return hit;
}

export type ProposedOpen = { text: string; quote: string; when?: string | null; nextStep?: string; commitment?: boolean; transition?: unknown };
export type ProposedClose = { id: string; status: "resolved" | "changed"; quote: string; newText?: string | null; transition?: unknown };

export type AcceptedOpen = { text: string; quote: string; quotedAt: string; dueDate: string | null; dueLabel: string | null; nextStep: NextStep; kind: "thread" | "commitment"; transition: TransitionSource | null; transitionChannel: LineVia | null };

// Pure: what goes through. `zone` is their time zone (or null → UTC), used to
// read "Friday" relative to the day they said it.
// The kind of the new line of a "changed" close. An inference stays tentative: if the thread on file is inferred, its replacement is inferred
// whatever the model returns (a junk value included). Otherwise a valid proposal stands, else the earlier thread's kind carries over.
export function changedCloseKind(proposed: unknown, prior: TransitionSource | null): unknown {
  if (prior === "inferred") return "inferred";
  return proposed === "said" || proposed === "inferred" || proposed === true ? proposed : prior ?? undefined;
}

export function gateThreadChanges(
  opens: ProposedOpen[],
  closes: ProposedClose[],
  onFile: MemberThread[],
  lines: OwnLine[],
  zone: string | null,
): { opened: AcceptedOpen[]; closed: (ProposedClose & { quotedAt: string })[]; checks: GateCheck[] } {
  const checks: GateCheck[] = [];
  const opened: AcceptedOpen[] = [];
  const closed: (ProposedClose & { quotedAt: string })[] = [];
  const live = onFile.filter((t) => t.status === "open" || t.status === "waiting");

  for (const c of closes) {
    const t = live.find((x) => x.id === c.id);
    const hit = findQuote(c.quote, lines);
    let reason: string | null = null;
    if (!t) reason = "thread isn't open";
    else if (c.status !== "resolved" && c.status !== "changed") reason = `bad status ${c.status}`;
    else if (!hit) reason = "no quote of theirs supports it";
    else if (hit.at <= t.openedAt.slice(0, 16)) reason = "quote isn't newer than the thread";
    else if (squash(c.quote) === squash(t.openedQuote)) reason = "same quote that opened it";
    // A bare reaction ("I like that.") is agreement with something said, not how it landed (2026-11-07 review, services/milestones.ts).
    else if (!closeSaysHowItLanded(t.text, c.quote)) reason = "a bare reaction doesn't say how it landed";
    checks.push({ name: "thread_close_quoted", pass: !reason, reason: `${c.id}: ${reason ?? `closed as ${c.status}`}` });
    if (!reason && hit && !closed.some((x) => x.id === c.id)) closed.push({ ...c, quotedAt: hit.at });
  }

  for (const o of [...opens, ...closed.filter((c) => c.status === "changed" && c.newText).map((c) => ({ text: c.newText!, quote: c.quote, transition: changedCloseKind(c.transition, live.find((x) => x.id === c.id)?.transition ?? null) }) as ProposedOpen)]) {
    const text = typeof o.text === "string" ? o.text.trim().slice(0, 200) : "";
    const hit = findQuote(o.quote, lines);
    let reason: string | null = null;
    if (!text) reason = "empty";
    else if (!hit) reason = "not in their own words";
    // The label may paraphrase ("locking in a venue" for "the spot we're
    // gonna head into"), but it has to share something with their words.
    else if (overlap(text, o.quote) === 0) reason = "thread doesn't match its quote";
    else if (live.some((t) => !closed.some((c) => c.id === t.id) && overlap(t.text, text) >= 0.6) || opened.some((x) => overlap(x.text, text) >= 0.6))
      reason = "already open";
    else if (live.length - closed.length + opened.length >= MAX_OPEN) reason = "too many open";
    checks.push({ name: "thread_open_quoted", pass: !reason, reason: `"${text.slice(0, 60)}": ${reason ?? "opened"}` });
    if (reason || !hit) continue;

    // Their date, read from their words the day they said it. The phrase has
    // to be inside the quote; the model's own date is never used.
    let dueDate: string | null = null;
    let dueLabel: string | null = null;
    const when = typeof o.when === "string" ? o.when.trim() : "";
    if (when && squash(o.quote).includes(squash(when))) {
      const saidAt = DateTime.fromISO(hit.at, { zone: "utc" }).setZone(wordsZone(zone));
      const w = parseAskWindow(spokenDayToDigits(when), saidAt);
      if (w) {
        dueDate = w.end.toISODate();
        dueLabel = w.label;
      }
    }
    const nextStep = NEXT_STEPS.includes(o.nextStep as NextStep) ? (o.nextStep as NextStep) : "check_in";
    // The model proposes the kind; the source is "inferred" unless it says "said" outright. A transition is always
    // opened from a quote of theirs (the gate above), so there is no transition without their own words.
    const transition: TransitionSource | null = o.transition === "said" ? "said" : o.transition === "inferred" || o.transition === true ? "inferred" : null;
    opened.push({ text, quote: o.quote.trim(), quotedAt: hit.at, dueDate, dueLabel, nextStep, kind: o.commitment && dueDate ? "commitment" : "thread", transition, transitionChannel: transition ? hit.via ?? null : null });
  }
  return { opened, closed, checks };
}

export function threadsPrompt(firstName: string, onFile: MemberThread[], lines: OwnLine[], zone: string | null = null): string {
  return `You keep the list of things ${firstName} is in the middle of: what they're working toward, deciding, waiting on, or looking forward to. Only their own life, never anything about Cue.

Open now:
${onFile.map((t) => `- [${t.id}] ${t.text}${t.dueDate ? ` (date: ${t.dueDate})` : ""}`).join("\n") || "(none)"}

What ${firstName} said recently, oldest first (their exact words):
${lines.map((l) => `- [${localStamp(`${l.at}:00Z`, zone)}] ${l.text}`).join("\n")}

1. Close a thread only when their words say how it landed or that it changed ("the pitch went great", "we moved it to November"). "quote" must be copied exactly from their words above, at least a few words. Being quiet about it is not a close.
2. Open a thread for each thing that matters to them right now and isn't on the list yet (usually one to four): something coming up with an outcome, a decision they're weighing, something they're working toward or worried about. Name it in their own terms (a short line, plain words, "they" for them, and the date if they gave one). "quote" is copied exactly from their words. If the quote names when ("Friday", "October 10th", "next week"), copy that phrase exactly as "when". Mark "commitment": true only when they said they themselves will do something by then ("I'll send the deck Friday").
Note on "transition": it changes nothing about whether to open a thread. For a thread you are already opening (or the new line of a "changed" close), mark it only if a life change (a move, a new role or company, going solo, starting over, a breakup, a new city, a career pivot) is happening now, about to happen, or just happened and they are still in the middle of it: "said" if they said the change outright, "inferred" if you are reading it from what they said. A change that is settled and behind them ("I moved here last year", "since I left banking") is background, not a transition, even if it still colours how they feel now: null. Otherwise null.
3. "nextStep": "check_in" (the default: there'll be news a friend would ask about), "look_up" (they asked for something to be found), "suggest_someone" (they want to meet a kind of person), or "remember" (only a background fact with nothing to ask about later).
Most of the time nothing changes; return empty lists then.

Return ONLY JSON: {"close": [{"id": "...", "status": "resolved" | "changed", "quote": "...", "newText": "what it changed to, or null", "transition": null}], "open": [{"text": "...", "quote": "...", "when": null, "nextStep": "check_in", "commitment": false, "transition": null}]}`;
}

function rowToThread(r: any): MemberThread {
  return {
    id: r.id,
    text: r.text,
    openedQuote: r.opened_quote,
    openedAt: new Date(r.opened_at).toISOString(),
    status: r.status,
    feeling: r.feeling,
    dueDate: r.due_date ? DateTime.fromJSDate(new Date(r.due_date), { zone: "utc" }).toISODate() : null,
    nextStep: r.next_step,
    kind: r.kind,
    closedQuote: r.closed_quote,
    lastTouchedAt: new Date(r.last_touched_at).toISOString(),
    transition: r.transition_source === "said" || r.transition_source === "inferred" ? r.transition_source : null,
    transitionChannel: r.transition_channel === "text" || r.transition_channel === "call" ? r.transition_channel : null,
  };
}

// Only ever called with the member's own id.
export async function listThreads(userId: string, statuses: ThreadStatus[] = ["open", "waiting"]): Promise<MemberThread[]> {
  const { rows } = await pool
    .query(`SELECT * FROM member_threads WHERE user_id = $1 AND status = ANY($2::text[]) ORDER BY opened_at`, [userId, statuses])
    .catch(() => ({ rows: [] as any[] }));
  return rows.map(rowToThread);
}

// A text they took back (2026-11-07 review: on 11-06 a member's "Cleanup: whether to delete the old pages, decks..." went to Cue by
// mistake, they said it was "the wrong chat", and the threads read still proposed "deciding whether to delete old pages, decks and design
// data"). Only a short line that is nothing but a take-back, anchored end to end ("wrong chat", "sorry, wrong person", "that wasn't
// meant for you", "ignore that last text"): "I just try to ignore that part", "she gave me the wrong number lol" and "HR sent it to the
// wrong person at first" are ordinary lines and stay. A line that also says something new ("actually disregard that, it's Austin") is
// a correction, never a take-back: both lines stay, and the earlier one carries the correction inline, so the newer word wins. A fact
// about where a text was sent, never about Cue's speech.
const FILLER = String.raw`(?:sorry|oops|whoops|my bad|ugh|lol|haha|ha|omg|oh|ah|actually|please|pls|plz)`;
// Strong: it names where the text went ("wrong chat", "not meant for you", "sent that to the wrong person"), within DISOWN_WINDOW_MINUTES.
const STRONG_TAKE_BACK = String.raw`(?:(?:that was |that's |this was |)(?:the )?wrong (?:chat|thread|convo|conversation|window|tab|text)|(?:that|this|it) (?:was|wasn'?t|is|isn'?t) (?:not )?(?:meant|supposed) (?:for|to go to) (?:you|cue|co)|not meant for you|(?:i )?sent (?:that|this|it) to the wrong (?:chat|person|thread|number))`;
// Weak: a bare "wrong person" / "ignore that" says nothing about where it went (after "Went on a date last night", "wrong person" is
// about the date). It takes back only the text right before it (within BURST_MINUTES) when that text looks meant for someone else.
const WEAK_TAKE_BACK = String.raw`(?:(?:that was |that's |)(?:the )?wrong person|(?:please |pls )?(?:ignore|disregard) (?:that|this)(?: last)?(?: one| message| text)?|(?:please |pls )?(?:ignore|disregard) (?:the|my) last (?:one|message|text))`;
const anchored = (core: string) => new RegExp(String.raw`^\s*(?:${FILLER}[\s,.!]*)*${core}(?:[\s,.!]*${FILLER})*[\s.!]*$`, "i");
export const STRONG_DISOWN = anchored(STRONG_TAKE_BACK);
export const WEAK_DISOWN = anchored(WEAK_TAKE_BACK);
export const DISOWNS = { test: (t: string) => STRONG_DISOWN.test(t) || WEAK_DISOWN.test(t) };
// Pure: a text that reads as written to someone else: it greets or names someone first ("Hey Sam,", "Mom:", "babe"), or it's a
// labelled note or paste ("Cleanup: ...", a list), never a line about their own life told to Cue.
// A "Name, ..." or "Word: ..." opener with their own life news in it ("Maya, my cofounder, quit today", "Stripe: we got the partnership")
// is them telling Cue, never a text meant for someone else.
// Family and partner terms: someone else, whatever follows. Casual ones ("Dude, the investor said yes!", "Bro, I finally shipped it") are
// as often said to Cue as to a friend, so they go through the own-news check like a name.
const FAMILY_ADDRESSEE = String.raw`(?:mom|mum|mommy|mama|ma|mother|dad|daddy|papa|pops|father|babe|baby|bae|honey|sweetie|sweetheart|grandma|grandpa|nana|granny|auntie|aunt|uncle)`;
const CASUAL_ADDRESSEE = String.raw`(?:dude|bro|brother|sis|sister|love|hon|son|kiddo|cuz|guys|team|all|everyone)`;
const OWN_NEWS = /\b(?:i|i'm|im|i've|i'd|my|me|we|we're|we've|our|us)\b/i;
const ADDRESSED = /^(?:(?:[Hh]ey|[Hh]i|[Hh]ello|[Yy]o|[Oo]k|[Oo]kay)\s+)?(?!(?:Ok|Okay|Yeah|Yes|No|So|Well|Also|Sure|Honestly|Actually|Lol|Haha|Hmm|Thanks|Update|Today|Tonight|Anyway|Btw|Oh|Ah|Wow|Cue|Co)\b)[A-Z][a-z]+\s*[,:]/;
export function meantForSomeoneElse(text: string): boolean {
  const t = text.trim();
  // A greeting first ("Hey Sam, I'm running late") is written to that person; a bare "Name," or "Word:" only without their own news in it.
  const greeted = /^(?:[Hh]ey|[Hh]i|[Hh]ello|[Yy]o)\s+(?!(?:Cue|Co)\b)[A-Z][a-z]+\s*[,:]/.test(t);
  // A family or partner addressee first ("Mom: landing at 6, can you pick me up?", "babe, ..."): written to them, whatever pronouns follow.
  const family = new RegExp(String.raw`^(?:(?:hey|hi|hello|yo)\s+)?${FAMILY_ADDRESSEE}\s*[,:!]|^(?:hey|hi|hello|yo)\s+${FAMILY_ADDRESSEE}\b`, "i").test(t);
  // A casual one only without their own news ("Dude, the investor said yes!" is news told to Cue).
  const casual = new RegExp(String.raw`^(?:(?:hey|hi|hello|yo)\s+)?${CASUAL_ADDRESSEE}\s*[,:!]|^(?:hey|hi|yo)\s+${CASUAL_ADDRESSEE}\b`, "i").test(t) && !OWN_NEWS.test(t) && !/!\s*$/.test(t);
  // A bare "Name," / "Word:" opener (never a casual addressee: those are read above), without their own news or an exclaimed one.
  const named = ADDRESSED.test(t) && !new RegExp(String.raw`^${CASUAL_ADDRESSEE}\b`, "i").test(t) && !OWN_NEWS.test(t);
  return greeted || family || casual || named || /\b(?:babe|honey|sweetie)\b/i.test(t) || /^\s*[-*\d]+[.)]?\s+\S/.test(t);
}
// "actually disregard that, it's Austin" / "scratch that, Austin": a correction of the text before it, with what's true now.
export const CORRECTS = new RegExp(String.raw`^\s*(?:${FILLER}[\s,.!]*)*(?:ignore that|disregard that|scratch that|no wait|correction)[\s,:;.!-]+(\S.*)$`, "i");
// Within this long before their take-back, the text it is about (the one right before it, and any sent with it in one burst).
const DISOWN_WINDOW_MINUTES = 30;
const BURST_MINUTES = 2;
const minutesOf = (at: string) => Date.parse(`${at.length === 16 ? `${at}:00` : at}Z`) / 60_000;
// Pure: the texts they took back (and the take-back itself) left out, and a correction applied to the text before it. Texts only: a call
// is one conversation.
export function withoutDisowned(lines: OwnLine[]): OwnLine[] {
  const gone = new Set<number>();
  const corrected = new Map<number, string>();
  const previousText = (i: number) => {
    for (let j = i - 1; j >= 0; j--) if (lines[j].via !== "call" && !gone.has(j)) return minutesOf(lines[i].at) - minutesOf(lines[j].at) <= DISOWN_WINDOW_MINUTES ? j : -1;
    return -1;
  };
  lines.forEach((l, i) => {
    if (l.via === "call") return;
    const fix = CORRECTS.exec(l.text);
    if (fix && !DISOWNS.test(l.text)) {
      const j = previousText(i);
      if (j >= 0) corrected.set(j, fix[1].trim().slice(0, 120));
      return;
    }
    const strong = STRONG_DISOWN.test(l.text);
    if (!strong && !WEAK_DISOWN.test(l.text)) return;
    if (!strong) {
      // A bare take-back: only the text right before it, sent moments before, that reads as meant for someone else.
      const j = previousText(i);
      if (j < 0 || minutesOf(l.at) - minutesOf(lines[j].at) > BURST_MINUTES || !meantForSomeoneElse(lines[j].text)) return;
    }
    gone.add(i);
    let prev = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (lines[j].via === "call" || gone.has(j)) continue;
      const gap = (prev < 0 ? minutesOf(l.at) : minutesOf(lines[prev].at)) - minutesOf(lines[j].at);
      if (prev < 0 ? gap > DISOWN_WINDOW_MINUTES : gap > BURST_MINUTES) break;
      // Beyond the text right before it, a text sent in the same burst goes too only when it is itself addressed to someone else.
      if (prev >= 0 && !meantForSomeoneElse(lines[j].text)) break;
      gone.add(j);
      prev = j;
    }
  });
  return lines.flatMap((l, i) => (gone.has(i) ? [] : [corrected.has(i) ? { ...l, text: `${l.text} [since corrected: ${corrected.get(i)}]` } : l]));
}
// Pure: their lines as the threads read may use them: what they took back left out, and each through the correction and removal guards
// (services/whatCoKnows.ts guardText: a removed part dropped, a corrected value noted inline).
export function usableLines(lines: OwnLine[], rows: import("../services/whatCoKnows.js").ForgottenRow[], guard: (text: string, rows: import("../services/whatCoKnows.js").ForgottenRow[]) => string | null): OwnLine[] {
  return withoutDisowned(lines).flatMap((l) => {
    const text = rows.length ? guard(l.text, rows) : l.text;
    return text ? [{ ...l, text }] : [];
  });
}

// newest: the newest 200 rows over the window (oldest first, as always), for a long window; default: the oldest 200, as before.
export async function ownLines(userId: string, days = LOOKBACK_DAYS, o: { newest?: boolean } = {}): Promise<OwnLine[]> {
  const { rows: got } = await pool.query(
    `SELECT created_at, memory_type, content FROM co_memories
     WHERE user_id = $1 AND created_at > NOW() - make_interval(days => $2)
       AND ((memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()}) OR memory_type = 'call_transcript')
     ORDER BY created_at${o.newest ? " DESC" : ""} LIMIT 200`,
    [userId, days],
  );
  const rows = o.newest ? [...got].reverse() : got;
  const out: OwnLine[] = [];
  for (const r of rows) {
    const at = new Date(r.created_at).toISOString().slice(0, 16);
    if (r.memory_type === "call_transcript") for (const t of userLinesFromTranscript(String(r.content))) out.push({ at, text: t.slice(0, 500), via: "call" });
    else out.push({ at, text: String(r.content).replace(/^User said:\s*/, "").slice(0, 500), via: "text" });
  }
  // What they took back, removed or corrected never comes back through their raw words (a failed guard read: their words as they are,
  // the took-back filter still applied).
  const W = await import("../services/whatCoKnows.js");
  const guards = await W.forgottenRows(userId).catch(() => [] as import("../services/whatCoKnows.js").ForgottenRow[]);
  return usableLines(out, guards, W.guardText);
}

// The feeling they had when they said it: the life emotion signal nearest the
// quote (within two hours), never one about Co.
async function feelingAt(userId: string, at: string): Promise<string | null> {
  const { rows } = await pool
    .query(
      `SELECT emotion, intensity FROM emotion_signals
       WHERE user_id = $1 AND COALESCE(target, 'life') = 'life'
         AND created_at BETWEEN $2::timestamptz - INTERVAL '2 hours' AND $2::timestamptz + INTERVAL '2 hours'
       ORDER BY abs(extract(epoch FROM created_at - $2::timestamptz)) LIMIT 1`,
      [userId, at + ":00Z"],
    )
    .catch(() => ({ rows: [] as any[] }));
  return rows[0] ? `${rows[0].emotion} (${rows[0].intensity})` : null;
}

// Their stored zone (services/memberTime.ts); null reads in the fallback zone.
const zoneFor = (userId: string): Promise<string | null> => memberZone(userId);

// A date they gave for something they said they'd do → a follow-up the
// morning after, through the same follow-up type as a searched time frame.
export async function queueCommitmentFollowUp(userId: string, threadId: string, text: string, dueDate: string, label: string, zone: string | null): Promise<boolean> {
  const endOfDay = DateTime.fromISO(dueDate, { zone: wordsZone(zone) }).endOf("day");
  if (!endOfDay.isValid || endOfDay < DateTime.now().minus({ days: 1 })) return false;
  const dueAt = nextLocalHour(endOfDay.toJSDate(), zone, 11);
  const payload: WindowFollowUpPayload = {
    kind: "commitment",
    label,
    asked: text,
    sent: [],
    dates: endOfDay.toFormat("cccc, LLLL d"),
  };
  const r = await enqueueCandidate({
    userId,
    type: "window_followup",
    targetKey: `thread:${threadId}`,
    topicKey: `thread:${threadId}`,
    summary: `Ask how "${text.slice(0, 80)}" went (they said ${label})`,
    payload,
    dueAt,
    expiresAt: new Date(dueAt.getTime() + 3 * 24 * 3600_000),
  }).catch(() => ({ queued: false }));
  return r.queued;
}

// Called after the person snapshot rebuilds (same throttle: after they've
// said something new). Non-fatal.
// Every model call inside is this member's in llm_usage (services/llmUsage.ts withMember, cost per member 2026-10-23).
export async function updateMemberThreads(...a: Parameters<typeof updateMemberThreadsInScope>): ReturnType<typeof updateMemberThreadsInScope> {
  return withMember(a[0], () => updateMemberThreadsInScope(...a));
}
async function updateMemberThreadsInScope(userId: string): Promise<void> {
  try {
    const [lines, onFile, user] = await Promise.all([
      ownLines(userId),
      listThreads(userId),
      pool.query(`SELECT first_name FROM users WHERE id = $1`, [userId]),
    ]);
    if (!lines.length) return;
    const firstName = user.rows[0]?.first_name || "them";
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet),
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { isEnabled: true, functionId: "memberThreads.update" },
      prompt: threadsPrompt(firstName, onFile, lines.slice(-80), await memberZone(userId)),
    });
    await applyThreadProposal(userId, parseModelJson<{ open?: ProposedOpen[]; close?: ProposedClose[] }>(text), onFile, lines);
  } catch (err: any) {
    console.error("updateMemberThreads failed (non-fatal):", err?.message ?? err);
  }
}

// What the threads read needs, loaded once (the snapshot rebuild folds the
// threads read into its own call: harness/personSnapshot.ts).
export async function threadInputs(userId: string): Promise<{ lines: OwnLine[]; onFile: MemberThread[] }> {
  const [lines, onFile] = await Promise.all([ownLines(userId), listThreads(userId)]);
  return { lines, onFile };
}

// Everything updateMemberThreads does after its model call: the same gates
// (quotes of their own words, their own dates) and writes.
export async function applyThreadProposal(
  userId: string,
  parsed: { open?: ProposedOpen[]; close?: ProposedClose[] } | null | undefined,
  onFile: MemberThread[],
  lines: OwnLine[],
): Promise<void> {
  try {
    if (!lines.length) return;
    parsed = parsed ?? {};
    const zone = await zoneFor(userId);
    // A thread they had removed (services/whatCoKnows.ts) isn't opened again from their older words.
    const forgotten = await import("../services/whatCoKnows.js").then((W) => W.forgottenRows(userId).then((rows) => ({ W, rows }))).catch(() => null);
    // The gate reads only the lines they still stand by (usableLines; ownLines already did this, and it's the same on lines read before),
    // so a quote from a text they took back, or a removed part of one, supports nothing.
    const usable = forgotten ? usableLines(lines, forgotten.rows, forgotten.W.guardText) : withoutDisowned(lines);
    const gated = gateThreadChanges(parsed.open ?? [], parsed.close ?? [], onFile, usable, zone);
    const { closed, checks } = gated;
    const opened = gated.opened.filter((o) => !forgotten?.W.forgets(o.text, forgotten.rows, "thread") && !forgotten?.W.forgets(o.quote, forgotten.rows, "their_words"));

    for (const c of closed) {
      await pool.query(
        `UPDATE member_threads SET status = $3, closed_quote = $4, closed_at = NOW(), last_touched_at = NOW() WHERE id = $1 AND user_id = $2`,
        [c.id, userId, c.status, c.quote],
      );
      // Nothing left to follow up on.
      await pool.query(`UPDATE proactive_candidates SET status = 'skipped', updated_at = NOW() WHERE user_id = $1 AND target_key = $2 AND status = 'pending'`, [userId, `thread:${c.id}`]).catch(() => {});
    }
    const queued: string[] = [];
    for (const o of opened) {
      const feeling = await feelingAt(userId, o.quotedAt);
      // The same thread from the same words is open once (a unique index, db/migrations.ts concurrencyMigrations, concurrency audit 2026-10-12): two
      // rebuilds applying one proposal used to open it twice and queue two check-ins. The second insert is refused and skipped.
      // If the transition columns aren't there (the migration failed or hasn't run), the thread still opens, as an ordinary one (42703 = undefined column).
      const { rows } = await pool
        .query(
          `INSERT INTO member_threads (user_id, text, opened_quote, opened_at, feeling, due_date, next_step, kind, transition_source, transition_channel)
           VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [userId, o.text, o.quote, o.quotedAt + ":00Z", feeling, o.dueDate, o.nextStep, o.kind, o.transition, o.transitionChannel],
        )
        .catch((err: any) => {
          if (err?.code !== "42703") throw err;
          return pool.query(
            `INSERT INTO member_threads (user_id, text, opened_quote, opened_at, feeling, due_date, next_step, kind)
             VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8) RETURNING id`,
            [userId, o.text, o.quote, o.quotedAt + ":00Z", feeling, o.dueDate, o.nextStep, o.kind],
          );
        })
        .catch((err: any) => {
          if (err?.code === "23505") return { rows: [] as any[] };
          throw err;
        });
      if (!rows[0]) continue;
      if (o.kind === "commitment" && o.dueDate && o.dueLabel && (await queueCommitmentFollowUp(userId, rows[0].id, o.text, o.dueDate, o.dueLabel, zone))) queued.push(rows[0].id);
    }
    // A thread they talked about again is fresh, even if nothing changed.
    for (const t of onFile) {
      if (closed.some((c) => c.id === t.id)) continue;
      if (lines.some((l) => l.at > t.lastTouchedAt.slice(0, 16) && overlap(t.text, l.text) >= 0.5)) {
        await pool.query(`UPDATE member_threads SET last_touched_at = NOW(), status = 'open' WHERE id = $1 AND user_id = $2`, [t.id, userId]);
      }
    }
    if (opened.length || closed.length || checks.some((c) => !c.pass)) {
      await recordDecision({
        layer: 4,
        decision: "profile.threads",
        userId,
        outcome: opened.length || closed.length ? "act" : "skip",
        action: `opened ${opened.length}, closed ${closed.length}, follow-ups ${queued.length}`,
        proposal: { proposed: parsed, opened, closed, queued },
        checks,
      });
    }
  } catch (err: any) {
    console.error("updateMemberThreads failed (non-fatal):", err?.message ?? err);
  }
}

// From the recap job: quiet threads move to "waiting". Never closes one.
export async function markQuietThreadsWaiting(userId: string): Promise<number> {
  const { rowCount } = await pool
    .query(
      `UPDATE member_threads SET status = 'waiting'
       WHERE user_id = $1 AND status = 'open' AND last_touched_at < NOW() - make_interval(days => $2)`,
      [userId, WAITING_AFTER_DAYS],
    )
    .catch(() => ({ rowCount: 0 }));
  return rowCount ?? 0;
}

// The one thread a companion check-in is about: past its date or undated,
// not a "remember" note, the one Co has touched least recently.
// ownedWork: what Co is working on for them (open tasks, running research briefs). A thread that is one of them is Co's to deliver,
// not theirs to report on (2026-10-12 intelligence audit: Co told Kofi "give me a day to dig into prices", then the check-in asked
// him "Anything coming to mind yet?"). That thread waits; the task's own messages say where it stands.
export function pickThreadForCheckin(threads: MemberThread[], today: string, ownedWork: string[] = []): MemberThread | null {
  const eligible = threads.filter(
    (t) => (t.status === "open" || t.status === "waiting") && t.nextStep !== "remember" && (!t.dueDate || t.dueDate < today) && !coOwns(t.text, ownedWork),
  );
  eligible.sort((a, b) => (a.lastTouchedAt < b.lastTouchedAt ? -1 : 1));
  return eligible[0] ?? null;
}

// Every reader of a thread gets it stamped with when they said it and whether it can still be stated as current
// (services/factLabels.ts stampOf): the recap, a draft, the reflection, the call briefing.
export function renderThreads(threads: MemberThread[], now: Date = new Date(), zone: string | null = null): string {
  return threads
    .map((t) => `- ${t.text} (${t.status}, ${stampOf({ saidOn: t.openedAt, confirmedOn: t.lastTouchedAt, dueOn: t.dueDate }, now, wordsZone(zone)).label}${t.feeling ? `, felt ${t.feeling}` : ""}; they said: "${t.openedQuote.slice(0, 160)}")`)
    .join("\n");
}

// Pure: the thread is something Co is working on for them (the same words, services/whatCoKnows.ts sameThing).
export function coOwns(threadText: string, ownedWork: string[]): boolean {
  return ownedWork.some((w) => sameThing(threadText, w));
}

// What Co is working on for them right now: open tasks and research briefs (co_tasks). Never throws.
export async function ownedWorkFor(userId: string): Promise<string[]> {
  return pool
    .query(`SELECT goal FROM co_tasks WHERE user_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 20`, [userId])
    .then((r) => r.rows.map((x: any) => String(x.goal ?? "")).filter(Boolean))
    .catch(() => [] as string[]);
}

// What a companion check-in carries (Royce, 2026-09-22: "One useful thing
// between conversations"): one open thread and at most one item for it.
// The only item today is a web finding for a "look_up" thread, read from its
// own page and checked by the same grounding gate as the sweep, under the web
// search budget. Deliberately not items:
//   - a person: a "suggest_someone" thread stays with the network intro flow
//     (services/networkIntroNudge.ts), which shares only the other member's
//     own stated ask and asks both first; the check-in never names anyone;
//   - a date clash: planned_event_mentions records one event under several
//     names (co-test, 2026-09-22: "October tenth event" and "black party" are
//     the same day and the same event), so a clash read from it would be wrong.
export type CompanionPayloadParts = {
  threadId: string | null;
  thread: { text: string; quote: string; dueDate: string | null; feeling: string | null } | null;
  item: { kind: "web"; name: string; url: string; reason: string } | null;
  checks: GateCheck[];
};

export async function companionPayloadFor(userId: string): Promise<CompanionPayloadParts> {
  const checks: GateCheck[] = [];
  const zone = await zoneFor(userId);
  const today = DateTime.now().setZone(wordsZone(zone)).toISODate()!;
  const owned = await ownedWorkFor(userId);
  const threads = await listThreads(userId);
  const thread = pickThreadForCheckin(threads, today, owned);
  const held = threads.filter((t) => coOwns(t.text, owned)).map((t) => t.text.slice(0, 60));
  if (held.length) checks.push({ name: "co_owns_thread", pass: true, reason: `left for Cue's own task: ${held.join("; ")}` });
  if (!thread) return { threadId: null, thread: null, item: null, checks: [...checks, { name: "open_thread", pass: false, reason: "no open thread due" }] };
  checks.push({ name: "open_thread", pass: true, reason: thread.text.slice(0, 80) });
  let item: CompanionPayloadParts["item"] = null;
  if (thread.nextStep === "look_up") {
    const { reserveWebSearch, searchWebForOpportunity } = await import("../services/webOpportunitySearch.js");
    const { checkGrounding } = await import("./matchGate.js");
    const budget = await reserveWebSearch(userId, "sweep", thread.text);
    if (!budget.ok) checks.push({ name: "web_budget", pass: false, reason: budget.reason ?? "over budget" });
    else {
      const { rows } = await pool.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
      // A failed search is recorded as one, never as "nothing found" (review of #225).
      const search = { failed: null as string | null };
      const found = await searchWebForOpportunity(thread.text, rows[0]?.city ?? null, null, today, { source: "sweep", failed: (why) => (search.failed = why) });
      const g = found ? checkGrounding(found, { searchCity: null, distanceMiles: null, alreadyOffered: false, now: new Date(), evidence: found.evidence ?? null }) : null;
      checks.push(g ?? (search.failed ? { name: "web_search", pass: false, reason: `the search failed: ${search.failed}` } : { name: "grounding", pass: false, reason: "nothing found" }));
      if (found && g?.pass) item = { kind: "web", name: found.name, url: found.url, reason: found.reason };
    }
  }
  return {
    threadId: thread.id,
    thread: { text: thread.text, quote: thread.openedQuote, dueDate: thread.dueDate, feeling: thread.feeling },
    item,
    checks,
  };
}
