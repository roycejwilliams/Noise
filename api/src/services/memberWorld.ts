// The member's world in one read, for a check-in or a casual opener (Royce, 2026-10-14: "a check-in gets presence PLUS one line of
// the member's actual world ... If genuinely nothing is running and nothing waits on them, pure presence is right"). At 12:04am on
// 10-14 "Just checking in" got "Good to hear from you. Nothing new on my end since this morning."; the reply check cut the second
// sentence as machinery talk, and what went out was dead air, while a fellowship question Co had sent at 5:30pm sat unanswered and
// the 9am search was carrying his goals. The drafter had no member-world facts for an opener, so it filled the gap with machinery.
//
// THIS IS THE STAND-IN for the planned discovery status contract (discoveryStatus). Until that exists, this is the one member-world
// read on the reply path, assembled from what the turn already reads plus one fenced read of the recent exchange:
//   running   what Co is doing for them now: open tasks, research briefs, and the daily search (the same items the running-work line
//             lists, harness/replyGrounding.ts runningWorkLine, built here by runningItems so the two can't disagree)
//   next      the soonest thing Co has scheduled for them (services/whatsAhead.ts), or the next morning's search
//   waiting   what waits on THEM, only what Co actually raised (Royce, 2026-10-14: "Co shouldn't nag about a draft it never actually
//             raised"): the question Co sent with a find of its own, last before this conversation, with nothing from them on any
//             channel since (texts, voice memos, calls, texts to a teammate); a goal split Co offered; a document Co offered. Never
//             one that's past its date, one they reacted to, a find while finds are let pass (services/kindRestraint.ts), anything
//             during a safety hold, or one Co already raised again (its own later texts name it). No loop status, working note or
//             draft gets here
//   thread    their live thread: the member thread touched most recently (harness/memberThreads.ts)
//   clock     their local time, so a midnight check-in reads as one
// When discoveryStatus lands, buildMemberWorld's input is read from it and nothing downstream changes shape.
//
// Everything here comes through the turn's one source fence (services/sourceFence.ts): their own conversation and Co's own records,
// another member's details stripped, a line the strip blanks counted in withheld and never shown. A failed fence withholds every
// line, so a failed read can never say "nothing is waiting". Nothing here decides whether their message is a check-in: Co does,
// from CHECKIN_RULE and these facts (house rule: Co decides, code guards facts). No model call; the one read runs alongside the
// turn's other reads.
// The principle for everything code adds (review, 2026-10-14): code adds or keeps a line only when it can prove the line true at
// send time; otherwise the cut goes out alone.
import { DateTime } from "luxon";
import { DAILY_SWEEP_HOUR } from "./dailySweep.js";
import { localStamp, validZone, wordsZone } from "./memberTime.js";
import { meaningWords } from "./profileExtraction.js";
import { NARRATION_RULES } from "./speakable.js";
import type { SearchCoverage } from "./searchCoverage.js";
import type { Ahead } from "./whatsAhead.js";
import type { ExchangeLine, Fence } from "./sourceFence.js";

export type WorldKind = "question" | "goal_split" | "doc_offer" | "task" | "brief" | "search_ask" | "search_goal" | "searching" | "scheduled" | "thread";
// fact: the words for Co's facts. name: the short thing itself (an event, a goal, a thread), for matching and the fallback line.
// endsOn: its date or deadline, as on file (a find's event date or deadline, a goal's moment), so a line about it is only said while
// it's still ahead.
export type WorldItem = { kind: WorldKind; fact: string; name: string | null; at?: string | null; endsOn?: string | null };
export type WorldClock = { local: string; hour: number; part: string; zoneKnown: boolean; sweepToday: boolean; zone: string | null; today: string };
export type MemberWorld = {
  clock: WorldClock;
  waiting: WorldItem[];
  running: WorldItem[];
  next: WorldItem | null;
  thread: WorldItem | null;
  // The one line a check-in leads with: what waits on them, else what's running. null: nothing waits and nothing runs.
  lead: WorldItem | null;
  // Lines the fence withheld, or reads that failed (another member's details, the fence, the exchange or activity read, an unknown
  // safety hold). Counted, never shown, and the fact never says "nothing" while any are.
  withheld: number;
  // Their own recent texts to Co (the fenced exchange), oldest first: what they told Co lately, so the thread read can tell a status
  // line Co can't know from one that says back their own news from an earlier turn.
  theirWords: string[];
};
// How many of their recent texts the thread read sees.
export const THEIR_WORDS_MAX = 12;
// A thing Co sent them (services/turnContext.ts SentItem): when, its date or deadline if on file, and any reaction to it.
export type SentRef = { name: string; sentAt: Date; endsOn?: string | null; reaction?: string | null };

// A conversation is one run of texts with no gap longer than this; what Co sent before it is "before this conversation".
export const SESSION_GAP_MINUTES = 90;
// A question older than this is history, not something waiting on them.
export const WAITING_MAX_DAYS = 3;
// How far back the exchange read goes, and how many lines.
export const EXCHANGE_HOURS = WAITING_MAX_DAYS * 24 + 2;
export const EXCHANGE_LINES = 40;
// A thing Co sent counts as the subject of its question when it went out within this of the question's lines.
const SENT_NEAR_MS = 3 * 60_000;

// Pure: the part of the day, the same words the turn's timeline uses (services/timeline.ts renderTimeline).
export function partOfDay(hour: number): string {
  return hour < 5 ? "late at night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 21 ? "evening" : "night";
}

// Pure: their clock. An unknown zone is said as the fallback, never passed off as theirs.
export function worldClock(now: Date, zone: string | null | undefined): WorldClock {
  const local = DateTime.fromJSDate(now).setZone(wordsZone(zone));
  return { local: `${local.toFormat("h:mm a")} on ${local.toFormat("cccc, LLLL d")}`, hour: local.hour, part: partOfDay(local.hour), zoneKnown: !!validZone(zone), sweepToday: local.hour < DAILY_SWEEP_HOUR, zone: validZone(zone) ?? null, today: local.toISODate()! };
}

// Pure: the day a date on file falls on, in their zone ("2026-12-15", an ISO instant, "Dec 15, 2026"), or null when it can't be read.
// Never depends on the server's own zone (Railway runs in UTC; PR #201's CI caught "Dec 15, 2026" reading as Dec 14 for a Pacific
// member): a bare date is that calendar day; a time with no zone is wall time in theirs; only an explicit zone converts: an ISO offset
// sitting directly on an ISO time ("T19:00-08:00", "Z"), or a named zone in free text (GMT, UTC, EST/EDT, CST/CDT, MST/MDT, PST/PDT).
// A "-21:00" after a time in free text is the end of a range ("19:00-21:00"), never an offset.
const ISO_OFFSET = /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const NAMED_ZONE = /\b(?:GMT|UTC|[ECMP][SD]T)\b/;
const RANGE_END = /(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\s*[-–]\s*\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?/i;
export function dayOf(on: string | null | undefined, zone: string | null): string | null {
  const t = String(on ?? "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const z = wordsZone(zone);
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) {
    const iso = ISO_OFFSET.test(t) ? DateTime.fromISO(t, { setZone: true }).setZone(z) : DateTime.fromISO(t, { zone: z });
    if (iso.isValid) return iso.toISODate();
  }
  // Free text ("Dec 15, 2026", "Dec 15, 2026 19:00-21:00", "Dec 15, 2026 11:30 PM PST"): a range keeps its start.
  // "7pm" is written out as "7:00 PM", the form Date.parse reads.
  const text = t.replace(RANGE_END, "$1").replace(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?![a-z])/gi, (_m, h: string, mm: string | undefined, ap: string) => `${h}:${mm ?? "00"} ${ap.toUpperCase()}M`);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || !/\b\d{4}\b/.test(text)) return null;
  // A named zone in the text: that instant, converted to theirs.
  if (NAMED_ZONE.test(text)) return DateTime.fromMillis(ms).setZone(z).toISODate();
  // No zone: Date.parse read it in the process's own zone, so its local fields are the calendar day as written, whatever that zone is.
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Pure: still ahead (or today). A date that can't be read is never proven ahead.
export function stillAhead(on: string | null | undefined, clock: Pick<WorldClock, "today" | "zone">): boolean {
  const d = dayOf(on, clock.zone);
  return !!d && d >= clock.today;
}
// Pure: proven past (a date that can't be read is not).
function provenPast(on: string | null | undefined, clock: Pick<WorldClock, "today" | "zone">): boolean {
  const d = dayOf(on, clock.zone);
  return !!d && d < clock.today;
}

// Pure: what is running for them, from the turn's own fact lines and search coverage. runningWorkLine says these same items.
const CARRIED_BRIEF = /^(?:Co is putting together research brief #|Research brief #\d+ for them, .* is finished but hasn't reached them yet)/;
export function runningItems(tasks: string[], briefs: string[], searching: SearchCoverage): (WorldItem & { label: string })[] {
  const out: (WorldItem & { label: string })[] = [];
  for (const t of tasks) {
    const m = t.match(/^Co is working on task #(\d+) for them: "([^"]+)"/);
    if (m) out.push({ kind: "task", label: `task #${m[1]}: "${m[2]}"`, fact: `Co's work for them: "${m[2]}"`, name: m[2] });
  }
  briefs.forEach((b) => {
    const m = b.match(/^(?:Co is putting together research brief|Research brief) #(\d+) for them, "([^"]+)"/);
    if (m && CARRIED_BRIEF.test(b)) out.push({ kind: "brief", label: `research brief #${m[1]}: "${m[2]}"`, fact: `the research Co is putting together for them: "${m[2]}"`, name: m[2] });
  });
  for (const a of searching.asks) out.push({ kind: "search_ask", label: `Co's daily search (every morning: events, the web and X) for what they asked: "${a.slice(0, 160)}"`, fact: `Co's daily search for what they asked: "${a.slice(0, 160)}"`, name: a.slice(0, 160) });
  for (const g of searching.goals) out.push({ kind: "search_goal", label: `Co's daily search for their goal: "${g.slice(0, 160)}"`, fact: `Co's daily search for their goal: "${g.slice(0, 160)}"`, name: g.slice(0, 160) });
  return out;
}

// Pure: the meaning words a sentence shares with a name. Two or more is a match; one shared word ("fundraising") never is.
const GENERIC = ["daily", "search", "searching", "look", "looking", "goal", "task", "work", "working", "thing", "things", "co", "still", "today", "tomorrow", "morning", "night", "question", "back", "news", "real", "yet", "now",
  // Everyday words that would make a greeting "name" a thread ("Good to hear from you" against "waiting to hear back from the venue").
  "from", "about", "with", "into", "over", "just", "hear", "heard", "good", "great", "you", "your", "them", "they", "this", "that", "what", "when", "there", "here"];
export function sharedWords(name: string, sentence: string): number {
  const s = meaningWords(sentence, GENERIC);
  const n = meaningWords(name, GENERIC);
  return [...n].filter((x) => s.has(x)).length;
}
const names = (name: string | null, sentence: string) => !!name && sharedWords(name, sentence) >= 2;

// Pure: the question Co sent with a find of its own, last before this conversation, if they haven't texted since. The exchange is
// fenced, oldest first; now is this message's moment (counted as theirs, whether or not its line is logged yet). A question with no
// find of Co's sent beside it (a rhetorical closer, "Big day tomorrow?") is never one. sessionStart: when this conversation began, so
// activity on other channels can be read against the gap. raisedAgain: a later text of Co's names the find (no repeat asks).
export type Unanswered = { question: string; at: string; name: string; endsOn: string | null; reaction: string | null; sessionStart: string; raisedAgain: boolean };
export function unansweredQuestion(lines: ExchangeLine[], now: Date, sent: SentRef[] = []): Unanswered | null {
  const xs = [...lines].sort((a, b) => a.at.getTime() - b.at.getTime()).filter((l) => l.at.getTime() <= now.getTime());
  // This conversation: back from now while no gap is longer than SESSION_GAP_MINUTES.
  let start = now.getTime();
  let i = xs.length - 1;
  for (; i >= 0; i--) {
    if (start - xs[i].at.getTime() > SESSION_GAP_MINUTES * 60_000) break;
    start = xs[i].at.getTime();
  }
  // The texts just before it: Co's last block, after their last text before this conversation.
  const block: ExchangeLine[] = [];
  for (let j = i; j >= 0 && xs[j].from === "co"; j--) block.unshift(xs[j]);
  if (!block.length) return null;
  const last = block[block.length - 1];
  if (!/\?\s*["')\]]*\s*$/.test(last.text)) return null;
  if (now.getTime() - last.at.getTime() > WAITING_MAX_DAYS * 86_400_000) return null;
  // The question's own send: the run of Co's lines that ends on it, each within SENT_NEAR_MS of the next (an earlier reply in the same
  // block is another moment, and what went out with it is not what this question is about).
  let first = block.length - 1;
  while (first > 0 && block[first].at.getTime() - block[first - 1].at.getTime() <= SENT_NEAR_MS) first--;
  const from = block[first].at.getTime() - SENT_NEAR_MS;
  const to = last.at.getTime() + SENT_NEAR_MS;
  const about = sent.filter((s) => s.sentAt.getTime() >= from && s.sentAt.getTime() <= to).sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0] ?? null;
  if (!about) return null;
  const raisedAgain = xs.some((l) => l.from === "co" && l.at.getTime() > last.at.getTime() && (names(about.name, l.text) || l.text.toLowerCase().includes(about.name.toLowerCase())));
  return { question: last.text.trim(), at: last.at.toISOString(), name: about.name, endsOn: about.endsOn ?? null, reaction: about.reaction ?? null, sessionStart: new Date(start).toISOString(), raisedAgain };
}

export type WorldInput = {
  now: Date;
  zone: string | null;
  // The fence's strip, or null when it failed (every line withheld).
  keep: (s: string) => string | null;
  // The turn's own reads (services/turnContext.ts): fact lines, coverage, scheduled work, goals, the doc offer, threads.
  tasks: string[];
  briefs: string[];
  searching: SearchCoverage;
  ahead: Ahead | null;
  offeredGoals: { title: string; offeredAt: string | null; momentOn?: string | null }[];
  docOffer: { topic: string; at?: string | null } | null;
  threads: { text: string; line: string }[];
  // null: the read failed, so what waits on them isn't known (counted as withheld, never as nothing).
  exchange: ExchangeLine[] | null;
  sent: SentRef[];
  // When they were active on any channel lately (texts, voice memos, calls, texts to a teammate), timestamps only. null: unread.
  activity: Date[] | null;
  // A safety hold is on (true), off (false), or couldn't be read (null: nothing waits, and it's counted as withheld).
  safetyHold: boolean | null;
  // Kinds Co doesn't start for them right now (services/kindRestraint.ts): finds let pass mean a sent find never waits on them.
  letPass: string[];
  // The fence or a read failed: some of their world can't be shown, so it never reads as empty.
  unreadable?: boolean;
};

// Pure: the member's world from the turn's reads. Priority, per Royce: something waiting on them comes before work running.
export function buildMemberWorld(o: WorldInput): MemberWorld {
  let withheld = o.unreadable || o.exchange === null ? 1 : 0;
  const keep = (s: string | null | undefined): string | null => {
    if (!s || !s.trim()) return null;
    const k = o.keep(s);
    if (!k) withheld++;
    return k;
  };
  const clock = worldClock(o.now, o.zone);
  const waiting: WorldItem[] = [];
  // Co's own later texts, for "already raised again" on an offer.
  const coSince = (at: string | null | undefined, name: string) => !!at && (o.exchange ?? []).some((l) => l.from === "co" && l.at.getTime() > new Date(at).getTime() + 10 * 60_000 && names(name, l.text));
  if (o.safetyHold === null) withheld++;
  if (o.safetyHold === false) {
    const q = o.exchange ? unansweredQuestion(o.exchange, o.now, o.sent) : null;
    if (q && !q.reaction && !q.raisedAgain && !provenPast(q.endsOn, clock) && !o.letPass.includes("find")) {
      // Nothing from them on any channel between the question and this conversation; activity that can't be read is withheld.
      const since = o.activity?.some((t) => t.getTime() > new Date(q.at).getTime() && t.getTime() < new Date(q.sessionStart).getTime() - 1000);
      if (o.activity === null) withheld++;
      else if (!since) {
        const question = keep(q.question);
        const name = keep(q.name);
        if (question && name) waiting.push({ kind: "question", name, at: q.at, endsOn: q.endsOn, fact: `"${name}", which Co sent ${localStamp(q.at, o.zone)} asking "${question.slice(0, 160)}"; nothing from them on any channel since` });
      }
    }
    for (const g of o.offeredGoals) {
      const title = keep(g.title);
      if (title && !provenPast(g.momentOn, clock) && !coSince(g.offeredAt, title)) waiting.push({ kind: "goal_split", name: title, at: g.offeredAt, endsOn: g.momentOn ?? null, fact: `the split Co offered for their goal "${title}", waiting on their pick` });
    }
    if (o.docOffer) {
      const topic = keep(o.docOffer.topic);
      if (topic && !coSince(o.docOffer.at, topic)) waiting.push({ kind: "doc_offer", name: topic, at: o.docOffer.at ?? null, fact: `Co's offer to write up "${topic}", waiting on their yes` });
    }
  }
  // Running: the turn's own items, already stripped by the turn; counted again here only if the strip blanks them now.
  const running: WorldItem[] = runningItems(o.tasks, o.briefs, o.searching).flatMap((r): WorldItem[] => {
    const name = keep(r.name);
    return name ? [{ kind: r.kind, name, fact: r.fact }] : [];
  });
  // Searched but not shown (another member in them, or a failed strip): still running, so a check-in never hears "nothing's on".
  const hiddenSearch = o.searching.hidden ?? 0;
  if (hiddenSearch && !running.length) running.push({ kind: "searching", name: null, fact: `Co's daily search for ${hiddenSearch} thing${hiddenSearch === 1 ? "" : "s"} they want (details not shown here)` });
  const searchingAny = o.searching.asks.length + o.searching.goals.length + hiddenSearch > 0;
  // Next: the soonest scheduled item, else the next morning's search.
  let next: WorldItem | null = null;
  const soon = (o.ahead?.tasks ?? []).filter((t) => new Date(t.nextCheckAt).getTime() > o.now.getTime()).sort((a, b) => +new Date(a.nextCheckAt) - +new Date(b.nextCheckAt))[0];
  if (soon) {
    const goal = keep(soon.goal);
    if (goal) next = { kind: "scheduled", name: goal, at: soon.nextCheckAt, fact: soon.kind === "followup" ? `a check-in with them, "${goal.slice(0, 140)}", ${localStamp(soon.nextCheckAt, o.zone)}` : `"${goal.slice(0, 140)}", around ${localStamp(soon.nextCheckAt, o.zone)}` };
  }
  if (!next && searchingAny) next = { kind: "searching", name: null, fact: `the daily search, ${clock.sweepToday ? "this" : "tomorrow"} morning from ${DAILY_SWEEP_HOUR}` };
  const t0 = o.threads[0];
  const threadText = t0 ? keep(t0.text) : null;
  const threadLine = t0 && threadText ? keep(t0.line) : null;
  const thread: WorldItem | null = threadText && threadLine ? { kind: "thread", name: threadText, fact: threadLine } : null;
  const lead = waiting[0] ?? running[0] ?? null;
  // Already fenced (sourceFence.ts fenceExchange: stripped, teammate lines dropped); only theirs, only from the window read.
  const theirWords = (o.exchange ?? []).filter((l) => l.from === "member").slice(-THEIR_WORDS_MAX).map((l) => l.text.slice(0, 240));
  return { clock, waiting, running, next, thread, lead, withheld, theirWords };
}

export const WAITS = new Set<WorldKind>(["question", "goal_split", "doc_offer"]);
export const RUNS = new Set<WorldKind>(["task", "brief", "search_ask", "search_goal", "searching"]);
// The fact line the drafter and the claim read see. Its opening words are how the reply check knows it (WORLD_FACT). The lead is said
// once, where it's listed. Nothing is ever said to be empty while some of it is withheld.
export const WORLD_FACT = /^Their world right now/;
export function memberWorldFact(w: MemberWorld): string {
  const time = `Their time: ${w.clock.local} (${w.clock.part})${w.clock.zoneKnown ? "" : `, read in ${wordsZone(null)}: their zone isn't known`}.`;
  const held = w.withheld ? ` ${w.withheld} more not shown here, so never say there's nothing.` : "";
  const leadMark = " (a check-in's one item)";
  const parts = [
    w.waiting.length ? `Waiting on them${leadMark}: ${w.waiting.slice(0, 2).map((x) => x.fact).join("; ")}.` : w.withheld ? null : "Nothing waits on them (not a thing to say).",
    w.running.length ? `Running${w.waiting.length ? " (background while something waits)" : leadMark}: ${w.running.slice(0, 3).map((x) => x.fact).join("; ")}${w.running.length > 3 ? `; ${w.running.length - 3} more` : ""}.` : w.withheld ? null : "Nothing is running (not a thing to say).",
    w.next ? `Next from Co: ${w.next.fact}.` : null,
    w.thread ? `Their thread (theirs to tell: ask, never report): ${w.thread.fact}.` : null,
  ].filter(Boolean);
  return `Their world right now: ${parts.join(" ")} ${time}${held}`.replace(/\s+/g, " ").trim();
}

// What the reply is told every text turn (Co decides whether their message is a check-in; the facts are always there).
export const CHECKIN_RULE =
  "A check-in or casual opener with no ask (you judge that from the thread) gets presence plus at most one item from \"Their world right now\", in their register, ending on something they can pull: what waits on them first, else what's running; a warm thread is asked about (\"any word from that venue?\"), never reported; with nothing running or waiting, presence and an open question only (\"good to hear from you, what's on your mind?\"), never a line saying nothing is waiting or running. That one item only, as something there for them (\"the Harbor Light fellowship is there if funding's on your mind\"), never as an answer they owe. One breath: no list, no status report, never your own machinery (\"nothing new on my end\"). Late at night their time (about 11pm to 5am) open soft (\"you're up late, everything ok?\"); the world line is optional then. Recent feelings shape the tone, never whether they hear their world. \"Tell me more\" expands that same item, with no new greeting.";

// Pure: the running item a sentence names (two or more shared meaning words), or null. Only running work: never a thread, never what
// waits on them. Word overlap misses a paraphrase ("still looking for a rooftop" against "a rooftop venue for the Sequin AI launch
// party" shares one word): that line is then cut and redrafted, which is accepted for now (review, 2026-10-14).
export function namesRunningItem(w: MemberWorld | null | undefined, sentence: string): WorldItem | null {
  return w?.running.find((i) => names(i.name, sentence)) ?? null;
}
// Pure: any item of their world a sentence names (two or more shared meaning words), for "already carries their world".
export function namesWorldItem(w: MemberWorld | null | undefined, sentence: string): WorldItem | null {
  if (!w) return null;
  return [...w.waiting, ...w.running, ...(w.thread ? [w.thread] : []), ...(w.next ? [w.next] : [])].find((i) => names(i.name, sentence)) ?? null;
}

// Co's own machinery, said aloud: always cut, whatever the sentence names (services/speakable.ts NARRATION_RULES).
const MACHINERY = NARRATION_RULES.filter((r) => r.why === "narrates Co's own machinery" || r.why === "task-tracker words");
export function machineryTalk(sentence: string): boolean {
  return MACHINERY.some((r) => r.pattern.test(sentence));
}
// The narration rules a line about running work may get past: where it stands ("still on the Sequin planning docs"). Machinery,
// tracker words and holding their thing behind Co's judgment ("once it's worth sending") never do.
export const WORLD_STATUS_WHYS = new Set([
  "opens on Co's own activity (task-tracker language)",
  "narrates what Co is doing instead of what they get",
  "reports not having it yet",
  "a progress report instead of the thing",
]);
// A search is only ever "still looking" or "on tomorrow's search", never progress or results.
const STILL_LOOKING = /\b(?:still (?:looking|searching|watching|on (?:it|the lookout))|keep(?:ing)? (?:looking|an eye out)|on (?:this|tomorrow)(?: morning)?'?s? search|search(?:es)? (?:again|each morning|every morning|tomorrow|this morning))\b/i;
const PROGRESS = /\b(?:found|find(?:ing)?s?|got|have|has|lined up|narrowed|shortlist(?:ed)?|options?|results?|leads?|close to|almost|getting closer|progress|promising|good ones?)\b/i;
// Pure: a sentence about running work the narration rule may let stand: it names a running item (task, brief or search; never their
// thread), every narration rule it trips is a where-it-stands one, and for a search it says only that it's still being looked for.
// The claim read still checks it against the facts.
export function worldLineAllowed(w: MemberWorld | null | undefined, sentence: string): boolean {
  const item = namesRunningItem(w, sentence);
  if (!item) return false;
  const s = sentence.replace(/[’‘]/g, "'");
  if (!NARRATION_RULES.filter((r) => r.pattern.test(s)).every((r) => WORLD_STATUS_WHYS.has(r.why))) return false;
  if (item.kind === "search_ask" || item.kind === "search_goal") return STILL_LOOKING.test(s) && !PROGRESS.test(s);
  return true;
}

// Their thread is asked about, never reported (Royce, 2026-10-14): Co has no record of where it stands. Whether a sentence REPORTS its
// status (heard back, confirmed, still nothing) or is advice, a plan, or what they told Co is meaning, so a small read decides
// (harness/replyGrounding.ts judgeThreadReports). Code only pre-filters which sentences to ask about: not a question, and naming the
// thread by its distinctive words (a place or a name, never only common nouns like "venue" or "dinner": "For the Hayes Valley dinner
// on the 14th, smart casual is right" is advice, and asking about it costs a read, never a cut).
const COMMON_NOUNS = new Set(
  "venue venues dinner dinners party parties launch event events meeting meetings place places call calls email emails trip trips date dates night nights week weeks day days lunch drinks show talk pitch plan plans wait waiting reply hear heard back team office spot spots room rooms table booking deal offer job interview the and jan feb mar apr may jun jul aug sep sept oct nov dec january february march april june july august september october november december".split(" "),
);
// Compared in the same stemmed form meaningWords gives ("venues" and "venue" alike).
let commonStems: Set<string> | null = null;
const distinctive = (name: string) => {
  commonStems ??= new Set([...COMMON_NOUNS].flatMap((w) => [w, ...meaningWords(w)]));
  return [...meaningWords(name, GENERIC)].filter((w) => !commonStems!.has(w) && !/^\d+(?:st|nd|rd|th)?$/.test(w));
};
// Where-it-stands words ("nothing yet", "still waiting", "heard back"): with them, a sentence that names the thread only by a common
// noun ("Nothing yet from the venue") is a candidate too (golden 30, 2026-10-17: it went out as a report, since "venue" alone never
// matched). The read still decides; this only decides what it's asked about.
const STANDS = /\b(?:nothing (?:yet|back|new|from)|no (?:word|news|reply|answer|update|response)(?: yet)?|not yet on|still (?:waiting|nothing|no word|hasn't|haven't)|haven't (?:heard|replied|gotten back)|hasn't (?:heard|replied|answered|gotten back)|heard back|got back to|came back|(?:are|is) (?:confirmed|booked|locked)|fell through|cancel+ed)\b/i;
// Waiting words are the shape of most thread names ("Waiting to hear back from..."): sharing them alone names no thread.
const WAIT_WORDS = new Set(["wait", "waiting", "waited", "hear", "heard", "hearing", "back"]);
export function threadCandidates(w: MemberWorld | null | undefined, text: string): string[] {
  const t = w?.thread;
  if (!t?.name) return [];
  const own = distinctive(t.name);
  return text
    .replace(/[’‘]/g, "'")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((s) => {
      if (/\?\s*["')\]]*$/.test(s)) return false;
      const words = meaningWords(s, GENERIC);
      // A thread with no distinctive word on file: two shared words of any kind, since the read decides.
      if (own.length ? own.some((x) => words.has(x)) : sharedWords(t.name!, s) >= 2) return true;
      // Only a common noun of the thread's, said with where it stands.
      return STANDS.test(s) && [...meaningWords(t.name!, GENERIC)].some((x) => !WAIT_WORDS.has(x) && words.has(x));
    });
}
// Pure: do the cut work claims themselves name their live thread (threadCandidates' match), every one of them? Then the cut was about
// their thread, never Co's own work: nothing of Co's should "start" on it (harness/replyGrounding.ts, the nothing-running line). Another
// cut sentence naming the thread doesn't count; a cut claim about Co's own work keeps the line.
export function workClaimsNameThread(w: MemberWorld | null | undefined, claims: string[]): boolean {
  return claims.length > 0 && claims.every((c) => threadCandidates(w, c).length > 0);
}
export const sentenceKey = (s: string) => s.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
// The read's question, for every candidate in one reply at once.
export function threadReadPrompt(thread: string, theirMessage: string, sentences: string[], theirWords: string[] = []): string {
  return `Co, a texting companion, is about to send these sentences to a member. The member has an open thread of their own: "${thread}". Only the member knows where it stands, so Co may only say where it stands when the member told Co.
What they just told Co: "${theirMessage.slice(0, 300)}"
${theirWords.length ? `What they texted Co before that, oldest first (their own words):\n${theirWords.map((w) => `- "${w}"`).join("\n")}\n` : ""}
Sentences:
${sentences.map((x, i) => `${i + 1}. "${x}"`).join("\n")}

For each sentence: does it state where that thread stands, as a fact (news, a reply, still waiting, nothing back, confirmed, booked, cancelled), rather than advice, a plan, a question, or saying back what the member themselves told Co?
A sentence that repeats, reacts to or builds on news the member gave (just now or before) is NOT a status report. For example, after "the venue said yes", "Great that the venue said yes" is not a report; with no news from them, "No word yet from the venue" is a report.

Return ONLY JSON: {"reports": [the numbers of the sentences that state where it stands]}`;
}

// Pure: what's left after the reply check cut a draft is dead air: Co was stating their world and the check took it away (a status
// sentence was cut: narration or a work claim), what's left is a few words of presence with no question, nothing went out earlier
// this turn, and their world has a true line it doesn't carry. Never an empty cut, and never under three words (the honest
// no-answer is that path's). Which paths win over it (the nothing-running line, a false denial, safety, discretion, invites) is
// decided where it's used (harness/replyGrounding.ts deadAirAt).
export const PRESENCE_MAX_WORDS = 8;
export const STATUS_CUTS = new Set(["no_internal_narration", "claim_work_status"]);
export function deadAir(o: { draft: string; cut: string; world: MemberWorld | null | undefined; failed: { name: string; pass: boolean }[]; sentThisTurn?: string[] }): boolean {
  // A live thread counts too: a check-in can ask about it, though code never adds a line about it (deadAirLine).
  if (!o.world?.lead && !o.world?.thread) return false;
  if ((o.sentThisTurn ?? []).some((m) => m.trim())) return false;
  if (!o.failed.some((c) => !c.pass && STATUS_CUTS.has(c.name))) return false;
  const cut = o.cut.trim();
  const words = cut.split(/\s+/).filter(Boolean).length;
  if (!cut || cut === o.draft.trim() || cut.includes("?")) return false;
  if (words < 3 || words > PRESENCE_MAX_WORDS) return false;
  return !cut.split(/(?<=[.!?])\s+/).some((s) => namesWorldItem(o.world, s));
}

// Pure: the grounded line that ends dead air when the redraft can't: built from the lead item's own words, only for items whose truth
// code can check at send time, so it's backed by construction. Always a plain statement in Co's voice, never a question and never
// asking them to do or decide anything (Royce, 2026-10-14: "A line that only fires after two failures shouldn't ask the member for
// anything"). Because it names their world, the reply it ends is never dead air again.
// No line: a thread (their news), the hidden search (unreadable or withheld), an ask (their own sentence, no label on file), a find
// whose date has passed or can't be read, anything with no name.
export function worldLine(w: MemberWorld | null | undefined): string | null {
  const l = w?.lead;
  return l ? worldStatement(l, w!.clock) : null;
}
// A short noun-phrase label: a few words, not their sentence ("I'm looking for...", "find me...").
export function labelLike(name: string): boolean {
  const t = name.trim();
  return t.split(/\s+/).length <= 9 && !/[.?!;:]/.test(t) && !/\b(?:i|i'?m|me|my|we|our|you|your)\b/i.test(t) && !/^(?:find|look|looking|search|get|help|can|could|please|need|want)\b/i.test(t);
}
export function worldStatement(l: WorldItem, clock: WorldClock): string | null {
  const n = l.name ? l.name.trim().replace(/[.?\s]+$/, "") : null;
  if (!n) return null;
  switch (l.kind) {
    // "There whenever you want it" claims it's still open: only with a date on file that is proven still ahead. No date, no line.
    case "question":
      return stillAhead(l.endsOn, clock) ? `${n} is there whenever you want it.` : null;
    case "goal_split":
      return !l.endsOn || stillAhead(l.endsOn, clock) ? `The split for "${n}" is there whenever you want it.` : null;
    case "doc_offer":
      return `The offer to write up "${n}" stands.`;
    case "search_goal":
      return labelLike(n) ? `${n.replace(/^./, (c) => c.toUpperCase())} is on ${clock.sweepToday ? "this" : "tomorrow"} morning's search.` : null;
    case "task":
    case "brief":
      return `I'm still on "${n}".`;
    case "scheduled":
      return l.at ? `Next up: "${n}", ${localStamp(l.at, clock.zone)}.` : null;
    default:
      return null;
  }
}

// Pure: the line code may add when the dead-air redraft couldn't be kept (review, 2026-10-14: let Co decide whether it was a check-in,
// and act only on that). checkin is the redraft's own answer: true, their world's lead line; anything else (false, or the read
// failed or didn't parse), at most a statement about the running item the cut sentence itself named, when it can be said true. A
// goodnight or a hard moment never gets their world's lead from code.
export function deadAirLine(o: { checkin: boolean | null; world: MemberWorld | null | undefined; draft: string; cut: string }): string | null {
  if (!o.world) return null;
  if (o.checkin === true) return worldLine(o.world);
  const kept = sentenceKey(o.cut);
  const removed = o.draft.replace(/[’‘]/g, "'").split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x && !kept.includes(sentenceKey(x)));
  for (const r of removed) {
    const item = namesRunningItem(o.world, r);
    if (item) return worldStatement(item, o.world.clock);
  }
  return null;
}
// Pure: a repair after a thread report was cut keeps every remaining sentence: the same sentences in the same order, each word for word,
// or changed only by replacing a pointing word (it, that, this, they, there, them) with words from the cut sentence (and a few joining
// words). A dropped, merged, added or rewritten sentence, flipped advice ("works" to "doesn't work") or a new name isn't a repair, and
// the cut goes out instead (review, 2026-10-14: the forced redraft must never shrink or change a good reply).
const POINTING = new Set(["it", "that", "this", "they", "there", "them"]);
const GLUE = new Set(["about", "the", "a", "an", "from", "of", "on", "with", "at", "for", "to", "in", "back", "your", "their"]);
const wordsOf = (t: string) => t.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
// Pure: the words a changed sentence dropped and added, by longest common subsequence.
function wordDiff(a: string[], b: string[]): { removed: string[]; added: string[] } {
  const L = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0) as number[]);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) removed.push(a[i++]);
    else added.push(b[j++]);
  }
  return { removed: [...removed, ...a.slice(i)], added: [...added, ...b.slice(j)] };
}
export function keepsEverySentence(cut: string, repaired: string, cutAway = ""): boolean {
  const split = (t: string) => t.replace(/[’‘]/g, "'").split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const a = split(cut);
  const b = split(repaired);
  if (!a.length || a.length !== b.length) return false;
  const from = new Set(wordsOf(cutAway));
  return a.every((x, i) => {
    if (x === b[i]) return true;
    const { removed, added } = wordDiff(wordsOf(x), wordsOf(b[i]));
    if (!removed.length && !added.length) return true;
    return removed.length > 0 && removed.every((w) => POINTING.has(w)) && added.length > 0 && added.every((w) => from.has(w) || GLUE.has(w));
  });
}

// Pure: the dead-air redraft's answer, {"checkin": true|false, "reply": "..."}, or null when it isn't that.
export function parseWorldRedraft(text: string | null | undefined): { checkin: boolean; reply: string } | null {
  const t = String(text ?? "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return typeof j?.checkin === "boolean" && typeof j?.reply === "string" ? { checkin: j.checkin, reply: j.reply.trim() } : null;
  } catch {
    return null;
  }
}

// The fenced reads this adds to a turn: their recent exchange with Co, both sides, and when they were active on any channel
// (services/sourceFence.ts readExchange, readActivityTimes).
export async function readRecentExchange(fence: Fence): Promise<ExchangeLine[] | null> {
  const F = await import("./sourceFence.js");
  return F.readExchange(fence, EXCHANGE_HOURS, EXCHANGE_LINES).catch(() => null);
}
export async function readRecentActivity(fence: Fence): Promise<Date[] | null> {
  const F = await import("./sourceFence.js");
  return F.readActivityTimes(fence, EXCHANGE_HOURS).catch(() => null);
}
