import { arcLine } from "./goalJourney.js";
import * as memberSafeModule from "./memberSafeMemories.js";
import { renderCorrections } from "../harness/profileWrite.js";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import pool from "../db/db.js";
import { writeMemory } from "./memory.js";
import { MODELS } from "../models.js";
import { getEmotionalContext, renderEmotionalContext } from "../harness/emotion.js";
import { renderSnapshot } from "../harness/personSnapshot.js";
import { latestAskEntry } from "../harness/profileWrite.js";
import { stampOf } from "./factLabels.js";
import { FALLBACK_ZONE } from "./memberTime.js";
import type { PersonModelParts } from "./personModel.js";
import type { SentItem } from "./turnContext.js";
import type { Exchange, Fact, KnowledgeDeps, KnowledgeSection, MemberKnowledge, MemberRules } from "./memberKnowledge.js";
import { plainCorrected } from "./memberKnowledge.js";
import { DateTime } from "luxon";

// A 1-2 sentence call summary: narrow work, Haiku.
const SUMMARY_MODEL = MODELS.haiku;

// Builds a compact summary of everything already known about a person —
// from a prior call's extracted profile/intent AND recent text exchanges —
// so a new call's opening can pick up from it instead of a cold generic
// greeting every time, regardless of which channel the prior context came
// from.
//
// Bug fix, 2026-09-01 (Royce, diagnosing a real memory-continuity gap live
// with Co: "earlier parts of what you told me didn't come through
// cleanly"): this used to hard-truncate to 600 characters and pull only the
// last 6 raw text_exchange rows (3 conversational turns), justified by a
// comment claiming the result "gets passed as a URL query param on the
// Twilio bridge connect URL." That mechanism doesn't exist anywhere in the
// current code — every actual caller (the call agent's variables in
// services/elevenLabsCalls.ts, postCallFollowUp.ts and sendblue.ts's LLM
// prompt interpolation) treats this as plain in-process text with no URL
// involved. The cap was real, it just wasn't protecting anything anymore —
// it was silently discarding real context on every call and every text
// reply, which is exactly the gap Co and Royce were diagnosing. Raised to a
// generous bound (still a bound, not unlimited — a defensive sanity check
// against a genuinely pathological profile, not a real constraint anyone
// should ever hit) and 20 rows (10 turns) of raw history instead of 3.
// recap (Royce, 2026-09-01: "go ahead and have that built") — the
// distilled, corrected running narrative services/memoryCompaction.ts
// maintains. Led with here since it's the durable, weighted-toward-recent
// picture; the raw recent-text line below still carries this-week's exact
// specifics the recap's own cadence hasn't folded in yet.
// What both a text reply's summary and a call's context are read from: one
// load, so the two channels see the same rows (2026-10-08).
//
// Member facts come from the one member-knowledge layer (services/memberKnowledge.ts, PR 4 of the migration): their goals with
// state, open asks, corrections, lessons, their own recent words and the recent exchanges, what Co carries and delivered, and
// restraint, each stamped and member-stripped inside the layer. One memberKnowledge call per build. What the layer doesn't hold
// stays here: the profile's own fields (life chapters, blockers, wants, the arc), the recap, the last suggestion, the emotional
// read in full, and the person model's structure (threads, loops, who).
type ContextParts = {
  k: MemberKnowledge;
  profile: any | null;
  corrections: CorrectionRow[];
  // Where they are headed: only goals still active (a done or stale goal is history, never direction).
  goals: string[];
  picture: string;
  model: PersonModelParts | null;
  ownWords: string[];
  openAsks: string[];
  recap: { text: string; at: Date | null } | null;
  recommendation: string | null;
  recentTexts: string[];
  emotionalLine: string | null;
  names: string[];
};

// The sections each build reads. A text reply's summary needs only the profile-side facts; a call reads what Co carries and
// delivered, the lessons, and restraint (for the member rules) too.
export const SUMMARY_KNOWLEDGE: readonly KnowledgeSection[] = ["goals", "asks", "corrections", "exchanges"];
export const CALL_KNOWLEDGE: readonly KnowledgeSection[] = ["goals", "asks", "corrections", "exchanges", "lessons", "delivered", "carrying", "restraint"];
// The recent texts (20) and their own words of the last 48 hours (25) both come from one exchange read.
export const CONTEXT_EXCHANGES = { exchanges: 45, exchangeDays: 30 } as const;
const RECENT_TEXTS = 20;
const OWN_WORDS = { max: 25, hours: 48 };

// Pure: a stored exchange line as the context shows it ("User said: ...", "Co replied: ...", "[Call] ...").
const exchangeLine = (x: Fact<Exchange>) => (x.from === "member" ? `User said: ${x.text}` : x.call ? `[Call] ${x.text}` : `Co replied: ${x.text}`);
// Pure: the layer's corrections as the rows this file's correction rules read.
export const correctionRows = (k: Pick<MemberKnowledge, "corrections">): CorrectionRow[] => k.corrections.map((c) => ({ field: c.field, old_value: c.was, new_value: c.now, corrected_at: c.verifiedAt }));
// Pure: the parts the layer covers. Their own words lately: their lines and Co's call summaries in the last 48 hours, oldest
// first; recent texts newest first.
export function partsFromKnowledge(k: MemberKnowledge): Pick<ContextParts, "corrections" | "goals" | "ownWords" | "openAsks" | "recentTexts"> {
  const since = new Date(k.asOf).getTime() - OWN_WORDS.hours * 3_600_000;
  const own = k.exchanges.filter((x) => (x.from === "member" || x.call) && new Date(x.verifiedAt).getTime() > since).slice(-OWN_WORDS.max);
  return {
    corrections: correctionRows(k),
    goals: k.goals.filter((g) => g.state === "active").map((g) => g.text),
    ownWords: own.map((x) => (x.from === "member" ? `- ${x.text}` : `[Call] ${x.text}`)),
    openAsks: k.asks.slice(0, 4).map((a) => `- ${a.text}`),
    recentTexts: k.exchanges.slice(-RECENT_TEXTS).reverse().map(exchangeLine),
  };
}

async function loadContextParts(userId: string, include: readonly KnowledgeSection[] = SUMMARY_KNOWLEDGE, deps: Partial<KnowledgeDeps> = {}, knowledge?: Promise<MemberKnowledge>): Promise<ContextParts> {
  const { memberKnowledge } = await import("./memberKnowledge.js");
  const [k, profileResult, recapResult, recentRecommendationResult, emotional, snapshot] = await Promise.all([
    knowledge ?? memberKnowledge(userId, { include, ...CONTEXT_EXCHANGES }, deps),
    // The profile fields the layer doesn't carry (city and goals come from it).
    pool.query(
      `SELECT life_chapters, blockers, availability_pattern, emotional_state, intent
       FROM co_profiles WHERE user_id = $1`,
      [userId],
    ),
    pool.query(
      `SELECT content, memory_type, created_at FROM co_memories
       WHERE user_id = $1 AND memory_type = 'recap'
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ),
    // Real gap found 2026-09-07: Co asked "what did you find me?" on a
    // fresh call had no way to answer — this summary read profile/text/
    // recap only, never what Co itself actually surfaced. One bounded,
    // recency-limited line (not the full pending/resolved offer machinery
    // sendblue.ts owns for text) covers the common "did I miss what you
    // found me" case without growing every call's opening context.
    pool.query(
      `SELECT content, memory_type FROM co_memories
       WHERE user_id = $1 AND memory_type = 'recommendation' AND created_at > NOW() - INTERVAL '3 days'
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ),
    // Emotion loop: the same read of how they've been feeling that texts
    // use, so a call opens knowing what the texts showed and vice versa.
    getEmotionalContext(userId),
    // The one model of them (services/personModel.ts); Co's action record
    // is added separately on calls (buildCallKnowledge), so it's left out here.
    import("./personModel.js").then((m) => m.personModelParts(userId)).catch(() => null),
  ]);
  const emotionalLine = renderEmotionalContext(emotional);

  // Another member's details never reach this summary; intro history stays
  // (services/memberSafeMemories.ts). The layer's parts are stripped inside it; these are the parts read here.
  const { memberSafe, linkedMemberNames, namesInRecords } = memberSafeModule;
  const linked = await linkedMemberNames(userId);
  // A Tier 0 pick names someone their recap or texts may describe too.
  const names = [...linked, ...namesInRecords(recentRecommendationResult.rows)];
  const [safeRecap, safeRecommendation] = await Promise.all([memberSafe(userId, recapResult.rows, names), memberSafe(userId, recentRecommendationResult.rows, names)]);
  // The person model is model-written (snapshot, threads, loops): it gets the
  // same strip, so another member's details never reach a call or reply.
  const rawPicture = snapshot ? (await import("./personModel.js")).renderPersonModel({ ...snapshot, did: [] }) : renderSnapshot(null);
  const picture = rawPicture ? ((await memberSafe(userId, [{ content: rawPicture, memory_type: "person_model" }], names))[0] ?? "") : rawPicture;
  const recapAt = recapResult.rows[0]?.created_at ? new Date(recapResult.rows[0].created_at) : null;
  const profile = profileResult.rows[0] ?? null;
  return {
    k,
    profile: profile || k.identity.city ? { ...(profile ?? {}), city: k.identity.city } : null,
    ...partsFromKnowledge(k),
    picture,
    model: snapshot,
    recap: safeRecap[0] ? { text: String(safeRecap[0]), at: recapAt } : null,
    recommendation: safeRecommendation[0] ? String(safeRecommendation[0]) : null,
    emotionalLine,
    names,
  };
}

// The profile's own lines, shared by both summaries. `keep` drops an item the
// caller knows is retired (the call context drops corrected goals and wants).
function profileLines(p: ContextParts, keep: (text: string) => boolean = () => true): (string | null)[] {
  const profile = p.profile;
  // The stated ask comes from the newest entry that actually has ask text;
  // wants come from the newest entry of any kind, because a call that found
  // no ask still writes wants (2026-09-20 — a text-less entry written last
  // was hiding the real ask from the call prompt).
  const latestAsk = latestAskEntry(profile?.intent);
  const latestIntent = Array.isArray(profile?.intent) && profile.intent.length ? profile.intent[profile.intent.length - 1] : null;
  // Direction, not errands: their goals still active (memberKnowledge: profile goals and goal entries joined with goal_states; a
  // goal they closed or let go stale is history, never direction), never an ask.
  const goals = p.goals.filter((g) => keep(String(g)));
  const wants = (latestIntent?.wants ?? []).filter((w: unknown) => keep(String(w)));
  const statedAsk = latestAsk?.text && keep(String(latestAsk.text)) ? latestAsk.text : null;
  return [
    profile?.life_chapters?.length ? `Life chapter: ${profile.life_chapters.join(", ")}` : null,
    profile?.city ? `City: ${profile.city}` : null,
    p.emotionalLine ? `How they've been feeling:\n${p.emotionalLine}` : null,
    goals.length ? `Goals: ${goals.slice(0, 4).join("; ")}` : null,
    profile?.blockers?.length ? `Blockers: ${profile.blockers.filter((b: unknown) => keep(String(b))).slice(0, 2).join("; ")}` : null,
    !p.openAsks.length && statedAsk ? `Stated ask: ${statedAsk}` : null,
    // Their arc: goals they have closed. A lens for the call, not something to recite.
    arcLine(profile?.intent),
    wants.length ? `Wants: ${wants.slice(0, 2).join(", ")}` : null,
    p.recommendation ? `Most recent thing Co suggested: ${p.recommendation}` : null,
  ].filter((l) => l !== `Blockers: `);
}

// Pure: Co's after-call promise records as plain facts, one per promise (2026-10-08: they were read back as "Looked into X ... and
// found nothing good enough to send yet", and the call's opening repeated that narration to the member). What was promised and
// whether it went out; never Co's judgment of its own work.
export function promiseFacts(rows: { at: Date | string; content: string }[]): { at: Date | string; text: string }[] {
  const seen = new Set<string>();
  const out: { at: Date | string; text: string }[] = [];
  for (const r of rows) {
    const what = r.content.match(/["“]([^"”]{3,200})["”]/)?.[1]?.trim() ?? r.content.replace(/^Looked into\s+/i, "").replace(/\s+after the call.*$/i, "").trim();
    const key = what.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter((w) => w.length > 3).slice(0, 5).join(" ");
    if (!what || seen.has(key)) continue;
    seen.add(key);
    const sent = /\b(sent|texted|shared)\b/i.test(r.content) && !/nothing|not sent|haven't|hasn't/i.test(r.content);
    out.push({ at: r.at, text: `Promised on the call: ${what}. ${sent ? "Sent." : "Not sent yet."}` });
  }
  return out;
}

// One item, said once (Royce, 2026-10-08 call eval: 4 of 9 outbound calls opened with "the PDF went out, wanted to make sure it
// landed"; the same deliverable sat in the call context five times: the promise, the "Not sent yet" line, the open loop, the
// recap, a thread). Lines about the same thing collapse into one; anything they already have (a delivery receipt, a promise
// marked sent) is marked "they have it" and moved out of "where things stand", so it never reads as a reason to talk. It's
// mentioned only if it changed since they last heard about it, they ask, or it directly answers what they just said (Royce, #114). Pure.
export type CarriedLine = { text: string; from: "promise" | "loop" | "thread" | "recap"; sent?: boolean };
export type Delivered = { title: string; at: Date | string };
const stem = (w: string) => {
  if (/^document/.test(w)) return "doc";
  const base = w.replace(/(?:ing|ed)$/, "");
  // "planning" -> "plan", "dropped" -> "drop".
  return base !== w ? base.replace(/([b-df-hj-np-tv-z])\1$/, "$1") : w;
};
// Places and days are not what a thing IS (review of #110: "San Francisco" matched a pitch-coach search to dinner options).
const NOT_WHAT = new Set(["san", "francisco", "sf", "bay", "area", "oakland", "berkeley", "nyc", "york", "soma", "mission", "hayes", "valley", "marina", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "tonight", "tomorrow", "today", "week", "weekend", "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december", "send", "text", "draft", "put", "together", "find", "get"]);
const stems = (s: string) => new Set([...meaningWords(s)].map(stem).filter((w) => !NOT_WHAT.has(w)));
// A line about Co's own work (what Co owes, said it would send, or sent), not the member's own life: only these are ever removed
// as "they have it" (review of #110: "their pitch deck for Thursday" and "a plan for their mom's birthday" were removed).
const ABOUT_CO_WORK = /\b(?:co|the assistant)\b[^.]{0,40}\b(?:said|says|sent|send|will|would|'ll|is putting|was putting|promised|drafted|drafting|finished|ready)\b|\b(?:promised on the call|keep your word|will be (?:sent|delivered|texted)|to be sent|sent to (?:their|his|her|royce's|the member's) texts?|doc(?:ument)? is ready|once ready)\b/i;
// A promise that names no thing of its own ("text the drafted planning document", "plan will be delivered once ready"): another
// wording of the call's deliverable. One that names something ("draft the investor update outline") is its own item.
const GENERIC_DELIVERABLE_WORDS = new Set(["plan", "doc", "document", "pdf", "brief", "draft", "outline", "memo", "deck", "sheet", "write", "writeup", "one", "pager", "deliver", "delivere", "ready", "once", "promis", "call", "will", "the", "and", "that", "this", "your", "you", "them", "it"]);
const genericPromise = (text: string) => [...stems(text.replace(/^-?\s*(?:(?:today|yesterday) \()?[A-Z][a-z]{2} \d{1,2}\)?:\s*/, "").replace(/Promised on the call:\s*/i, "").replace(/\.\s*(?:Not sent yet|Sent)\.?$/i, ""))].filter((w) => !GENERIC_DELIVERABLE_WORDS.has(w)).length === 0;
const sameThing = (a: string, b: string) => {
  const A = stems(a), B = stems(b);
  const small = Math.min(A.size, B.size);
  return small > 0 && shared(A, B) >= Math.max(2, Math.ceil(small * 0.5));
};
// A line that is about a deliverable Co owes or sent (a doc, plan, brief, PDF, draft, write-up, options, research).
const DELIVERABLE = /\b(?:doc|document|pdf|plan|brief|draft|write-?up|outline|memo|deck|options|research|shortlist|one-pager|sheet)\b/i;
export function collapseCarried(lines: CarriedLine[], delivered: Delivered[], zoneDay: (d: Date | string) => string): { open: CarriedLine[]; theyHaveIt: string[]; covered: (text: string) => boolean } {
  const handled: { title: string; at: Date | string }[] = [...delivered];
  // A promise marked sent is handled too: its words are the title.
  for (const l of lines) if (l.from === "promise" && l.sent) handled.push({ title: l.text.replace(/^-?\s*[^:]*:\s*Promised on the call:\s*/i, "").replace(/\.\s*Sent\.?$/i, ""), at: "" });
  // One call often says one deliverable three ways ("draft and text a plan", "text the drafted planning document", "plan will be
  // delivered once ready"): a deliverable promised on the same call day as one that went counts as that one.
  // "Oct 7:" or, for recent days, "today (Oct 8):" / "yesterday (Oct 7):" (dayLabel): the date inside either way (review of #114).
  const dayOf = (t: string) => t.match(/^-?\s*(?:(?:today|yesterday) \()?([A-Z][a-z]{2} \d{1,2})\)?:/)?.[1] ?? null;
  // Two deliverable mentions are the same thing on two distinctive shared words ("the post-event presence doc" and "Co Presence
  // Plan: After the ... Event"); a looser match than for open items, because both name a deliverable.
  const sameDeliverable = (text: string, title: string) => { const A = stems(text), B = stems(title); return shared(A, B) >= 2 || sameThing(text, title); };
  const byTitle = (text: string) => DELIVERABLE.test(text) && handled.some((h) => sameDeliverable(text, h.title));
  const sentDays = new Set(lines.filter((l) => l.from === "promise" && DELIVERABLE.test(l.text) && (l.sent || byTitle(l.text))).map((l) => dayOf(l.text)).filter(Boolean));
  const isHandled = (text: string) => DELIVERABLE.test(text) && (byTitle(text) || (!!dayOf(text) && sentDays.has(dayOf(text)) && genericPromise(text)));
  const open: CarriedLine[] = [];
  for (const l of lines) {
    if ((l.from === "promise" && l.sent) || isHandled(l.text)) continue;
    // A duplicate of something already kept (the promise and its open loop): one line, the more specific (longer) one.
    const dup = open.findIndex((o) => sameThing(o.text, l.text));
    if (dup >= 0) {
      if (l.text.length > open[dup].text.length && l.from !== "recap") open[dup] = l;
      continue;
    }
    if (l.from === "promise" || l.from === "loop") open.push(l);
  }
  const theyHaveIt: string[] = [];
  const seen: string[] = [];
  for (const h of handled) {
    if (!h.title.trim() || seen.some((x) => sameThing(x, h.title))) continue;
    seen.push(h.title);
    theyHaveIt.push(`- "${h.title.slice(0, 120)}"${h.at ? ` (sent ${zoneDay(h.at)})` : ""}`);
  }
  // Threads, recap and last-call lines: only a line about Co's own work is ever dropped, never the member's own plans or decks.
  return { open, theyHaveIt, covered: (text: string) => ABOUT_CO_WORK.test(text) && (isHandled(text) || open.some((o) => o.from !== "recap" && sameThing(o.text, text) && DELIVERABLE.test(text))) };
}

export const CONTEXT_MAX = 4500;
// Each part's share of CONTEXT_MAX (they add up to a little under it, with room for the short profile lines).
export const CONTEXT_SHARES = { corrections: 700, picture: 1300, ownWords: 750, openAsks: 450, recap: 450, recentTexts: 450 };
// Pure: text cut to at most `cap` characters at a line (or, for one long line, a word) boundary.
export function trimToLines(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const lines = text.split("\n");
  let out = "";
  for (const l of lines) {
    const next = out ? `${out}\n${l}` : l;
    if (next.length > cap) break;
    out = next;
  }
  if (out) return out;
  return `${text.slice(0, cap).replace(/\s+\S*$/, "")}...`;
}

export async function buildContextSummary(userId: string): Promise<string> {
  try {
    return await contextSummary(userId);
  } catch (err: any) {
    console.error("callContext: buildContextSummary failed (non-fatal, calling with no prior context):", err?.message ?? err);
    return "";
  }
}

// The plain summary; throws when it can't be read (buildContextSummary turns that into "", a call into CALL_NOTES_UNAVAILABLE).
async function contextSummary(userId: string): Promise<string> {
  {
    const p = await loadContextParts(userId);
    const corrections = renderCorrections(p.corrections);
    // Each part gets its own share, trimmed at a line, so a long part can't crowd out the rest (2026-10-08: the loop below used to
    // stop at the first part that didn't fit, and a member with a long picture got only their corrections: no picture, no recent
    // words, no asks, no recap, no recent texts).
    const part = (head: string, body: string | null | undefined, cap: number) => (body && body.trim() ? `${head}${trimToLines(body.trim(), cap)}` : null);
    const lines = [
      part("Things they've corrected (the corrected version wins over anything below; never state the old one as true, and if they ask what you had or when it changed, say it plainly with the date):\n", corrections, CONTEXT_SHARES.corrections),
      part("What you know about them right now:\n", p.picture, CONTEXT_SHARES.picture),
      part("What they've told you in the last two days (newest facts win over anything below):\n", p.ownWords.join("\n"), CONTEXT_SHARES.ownWords),
      part("What they're looking for right now:\n", p.openAsks.join("\n"), CONTEXT_SHARES.openAsks),
      part("Ongoing summary: ", p.recap?.text, CONTEXT_SHARES.recap),
      ...profileLines(p),
      part("Recent texts: ", [...p.recentTexts].reverse().join(" / "), CONTEXT_SHARES.recentTexts),
    ].filter(Boolean) as string[];

    // Newest and most important parts come first. A part that still doesn't fit is skipped, never the end of the summary.
    let summary = "";
    for (const line of lines) {
      const next = summary ? `${summary}\n\n${line}` : line;
      if (next.length > CONTEXT_MAX) continue;
      summary = next;
    }
    return summary;
  }
}

// ---------- what a call starts with
// Royce, 2026-09-28 ("On calls: what should carry over"), and the 2026-10-08
// call review: two calls in a row opened on stale items. The summary listed a
// goal they had corrected ("first paying customer") under what they were in the
// middle of, the current situation (event cancelled, a November event with
// Sequin AI) only showed up as a list of corrections, and there was no summary
// of the last call, so Co re-learned news it already had.
//
// Now a call reads the same model of the person as texting
// (services/personModel.ts: snapshot, threads, Co's open loops), current
// situation first, with the last calls dated, and anything they corrected or
// retired dropped from what's current. A correction still shows once, as
// "settled: X (not Y)", so Co doesn't bring the old version back.
//
// Returns the spoken-context summary plus the same knowledge split for the
// after-call audit: facts (what Co sent and what's on file, Co's own record,
// their asks in their words) and impressions (summaries and read-outs Co's
// models wrote), which never count as proof of a specific fact.
export type CallKnowledge = { summary: string; facts: string; impressions: string };
export type CorrectionRow = { field: string; old_value: string; new_value: string | null; corrected_at: Date | string };

// Room for the whole picture (about 2,000 tokens): 4,500 was spent mostly on the sent events, and the
// build stopped at the first section that didn't fit, so the background that
// lets Co pick up where they left off (what they told it lately, the ongoing
// recap, recent texts, how they've been feeling) was cut (2026-10-04: a call
// opened with "what's happening these days?" while holding a 4,227-character
// summary that ended after the first of those sections).
export const CALL_CONTEXT_MAX = 8000;
// What was sent lately matters for facts (times, places on file), but it is the
// longest block and the least about them: whole lines, capped.
export const CALL_SENT_MAX = 1800;
// How many past calls the context summarizes, and how far back.
export const LAST_CALLS = 3;
const LAST_CALLS_DAYS = 30;
const OLDER_CALL_CHARS = 320;
// Only the fallback (services/memberTime.ts); the briefing passes their zone.
const ZONE = FALLBACK_ZONE;

// ---- corrected and retired items
// The words that carry an item's meaning (three letters or more, so a name like Joy counts; a light plural strip).
const RETIRE_STOP = new Set("the and for but not you are was has had his her its our get got out all any can did one two now new way who how why yet own see let use via with that this what your have just like would want wants into some more they them their from about also really things people still going trying there been being after before then than over".split(" "));
function meaningWords(s: string): Set<string> {
  return new Set((String(s).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !RETIRE_STOP.has(w)).map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)));
}
function shared(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}
const says = (item: Set<string>, value: string | null) => {
  if (!value) return false;
  const v = meaningWords(value);
  const n = shared(item, v);
  return v.size > 0 && ((n >= 2 && n >= 0.6 * v.size) || n >= 3);
};
// Pure: the correction an item restates the old side of, or null. An item that
// also says the corrected version, or came up again after the correction, is
// current. Never applied to Co's open loops: those are Co's own live record.
export function retiredBy(text: string, corrections: CorrectionRow[], lastSaid?: Date | string | null): CorrectionRow | null {
  const item = meaningWords(text);
  if (!item.size) return null;
  const said = lastSaid ? new Date(lastSaid).getTime() : null;
  for (const c of corrections) {
    if (!says(item, c.old_value)) continue;
    if (says(item, plainCorrected(c.new_value).text)) continue;
    if (said !== null && Number.isFinite(said) && said > new Date(c.corrected_at).getTime()) continue;
    return c;
  }
  return null;
}
// Pure: a correction whose new version was itself corrected later is covered by the later one.
function superseded(c: CorrectionRow, all: CorrectionRow[]): boolean {
  if (!c.new_value) return false;
  const at = new Date(c.corrected_at).getTime();
  const now = plainCorrected(c.new_value).text;
  return all.some((d) => d !== c && new Date(d.corrected_at).getTime() > at && d.field === c.field && (d.old_value === now || says(meaningWords(d.old_value), now)));
}
const LABELS: Record<string, string> = { city: "where they live", life_chapters: "life chapter", goals: "goal", blockers: "what's in their way", activity_preferences: "what they like doing", long_term_direction: "long-term direction", availability_pattern: "when they're free" };
// Today and yesterday say so, in their zone: "Oct 8" on October 8 read as yesterday on a call ("Yesterday, October 8th", 2026-10-08 eval).
const dayLabel = (d: Date | string, zone = ZONE, now = new Date()) => {
  const day = DateTime.fromJSDate(new Date(d)).setZone(zone);
  const today = DateTime.fromJSDate(now).setZone(zone).startOf("day");
  const diff = Math.round(day.startOf("day").diff(today, "days").days);
  const label = day.toFormat("LLL d");
  return diff === 0 ? `today (${label})` : diff === -1 ? `yesterday (${label})` : label;
};
// Pure: "settled: X (not Y)", newest first, one line per correction still standing.
export function renderSettled(rows: CorrectionRow[], zone = ZONE): string {
  return rows
    .filter((r) => !superseded(r, rows))
    .map((r) => {
      const label = LABELS[r.field] ?? r.field;
      return r.new_value ? `- ${label}, ${dayLabel(r.corrected_at, zone)}: ${r.new_value} (not "${r.old_value}")` : `- ${label}, ${dayLabel(r.corrected_at, zone)}: not "${r.old_value}" (they said that's wrong)`;
    })
    .join("\n");
}
// Pure: a corrected name written the right way ("Sequent AI" heard on a call, corrected to "Sequin AI").
export function withCorrectedNames(text: string, corrections: CorrectionRow[]): string {
  let out = text;
  for (const raw of corrections) {
    if (!raw.new_value) continue;
    const c = { ...raw, new_value: plainCorrected(raw.new_value).text };
    const words = (s: string) => s.trim().split(/\s+/).length;
    if (words(c.old_value) > 4 || words(c.new_value) > 4 || !/^[A-Z]/.test(c.old_value.trim())) continue;
    out = out.replace(new RegExp(`\\b${c.old_value.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), c.new_value.trim());
  }
  return out;
}

// ---- the last calls
export type PastCall = { at: Date | string; summary: string | null; theirWords: string[] };
// Pure: a dated line per call, newest first. A call with no summary note shows
// the first things they said on it.
export function renderLastCalls(calls: PastCall[], now = new Date(), zone = ZONE): string {
  const today = DateTime.fromJSDate(now).setZone(zone).startOf("day");
  return calls
    .map((c, i) => {
      const day = DateTime.fromJSDate(new Date(c.at)).setZone(zone);
      const ago = Math.round(today.diff(day.startOf("day"), "days").days);
      const when = `${day.toFormat("LLL d")}${ago <= 0 ? ", today" : ago === 1 ? ", yesterday" : `, ${ago} days ago`}`;
      // The newest call in full; older ones shortened at a sentence, so three calls fit.
      const summary = c.summary && i > 0 && c.summary.length > OLDER_CALL_CHARS ? `${(c.summary.slice(0, OLDER_CALL_CHARS).match(/^[\s\S]*[.!?](?=\s)/)?.[0] ?? c.summary.slice(0, OLDER_CALL_CHARS))}` : c.summary;
      const body = summary ?? (c.theirWords.length ? `no summary on file; they said: ${c.theirWords.map((w) => `"${w}"`).join(" ")}` : null);
      return body ? `- ${when}: ${body}` : null;
    })
    .filter(Boolean)
    .join("\n");
}
// Pure: each stored call transcript (newest first) paired with the "[Call]"
// summary written right after it.
export function pairCalls(rows: { created_at: Date | string; memory_type: string; content: string }[], max = LAST_CALLS): PastCall[] {
  const transcripts = rows.filter((r) => r.memory_type === "call_transcript" && /^(assistant|user):/m.test(r.content)).sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  const notes = rows.filter((r) => r.memory_type === "text_exchange" && r.content.startsWith("[Call]"));
  const used = new Set<number>();
  return transcripts.slice(0, max).map((t) => {
    const at = +new Date(t.created_at);
    const i = notes.findIndex((n, k) => !used.has(k) && +new Date(n.created_at) >= at - 60_000 && +new Date(n.created_at) <= at + 20 * 60_000);
    if (i >= 0) used.add(i);
    const note = i >= 0 ? notes[i].content.replace(/^\[Call\]\s*/, "").trim() : null;
    const theirWords = t.content.split("\n").filter((l) => l.startsWith("user:")).map((l) => l.replace(/^user:\s*/, "").trim()).filter((l) => l.split(/\s+/).length >= 4).slice(0, 2).map((l) => l.slice(0, 160));
    // A note too short to say anything ("Royce called back and greeted Co") isn't a summary.
    return { at: t.created_at, summary: note && note.length >= 80 ? note : null, theirWords };
  });
}

// Pure: the call's context from its parts, current situation first, within `max`:
//   1. where things stand now (what Co is carrying for them, its open loops)
//   2. the last calls, dated
//   3. what they're in the middle of (current threads)
//   4. settled: what they corrected, new version first
//   5. how to be with them (corrections to Co's manner; short)
//   6. the rest of what's known (their own words lately, open asks, who they
//      are, the recap, how they've been feeling, recent texts, ...)
//   7. older threads, as questions
//   8. what was sent lately, last and bounded, with the facts on file
// A thread line stamped OLD goes to 7. A section that doesn't fit is skipped,
// not the end of the build, so a long one can't take every later short one with it.
export function assembleCallSummary(o: { haveIt?: string | null; now?: string | null; lastCalls?: string | null; settled?: string | null; lessons: string[]; sentLines: string[]; threads: { text: string; line?: string }[]; base: string; max?: number; sentMax?: number }): string {
  const max = o.max ?? CALL_CONTEXT_MAX;
  const sentMax = o.sentMax ?? CALL_SENT_MAX;
  const now = o.now ? `Where things stand now (start here). ${o.now}` : null;
  const lastCalls = o.lastCalls ? `Your last calls with them (newest first):\n${o.lastCalls}` : null;
  const settled = o.settled ? `Settled (they corrected these: say only the new version, never bring back the old one; if they ask what changed or when, say it plainly):\n${o.settled}` : null;
  const lessons = o.lessons.length ? `How to be with them, from times they corrected you (keep to these):\n${o.lessons.map((l) => `- ${l}`).join("\n")}` : null;
  const lineOf = (t: { text: string; line?: string }) => t.line ?? t.text;
  const isOld = (t: { text: string; line?: string }) => /\bOLD\b/.test(lineOf(t));
  const current = o.threads.filter((t) => !isOld(t));
  const older = o.threads.filter(isOld);
  const threads = current.length ? `What they're in the middle of:\n${current.slice(0, 5).map((t) => `- ${lineOf(t)}`).join("\n")}` : null;
  const olderThreads = older.length ? `Older threads, not current (ask whether one is still true before you bring it up):\n${older.slice(0, 5).map((t) => `- ${lineOf(t)}`).join("\n")}` : null;
  const header = "What you sent them lately and what's on file for each (these are the facts; if a time or place isn't listed here, you don't have it, so say so plainly):\n";
  const kept: string[] = [];
  let used = header.length;
  for (const l of o.sentLines) {
    const line = `- ${l}`;
    if (used + line.length + 1 > sentMax && kept.length) break;
    if (used + line.length + 1 > sentMax) continue;
    kept.push(line);
    used += line.length + 1;
  }
  const sent = kept.length ? `${header}${kept.join("\n")}` : null;
  const reserve = sent ? sent.length + 2 : 0;
  // What they already have goes after what's current: background, never a reason to talk.
  const haveIt = o.haveIt ? `They already have these (not news, never a reason to call or an opener; mention one only if it changed since they last heard about it, they ask, or it directly answers what they just said):\n${o.haveIt}` : null;
  const parts = [now, lastCalls, threads, settled, lessons, ...o.base.split("\n\n"), haveIt, olderThreads].filter((x): x is string => !!x);
  let summary = "";
  for (const part of parts) {
    const next = summary ? `${summary}\n\n${part}` : part;
    if (next.length + reserve > max) continue;
    summary = next;
  }
  return sent ? (summary ? `${summary}\n\n${sent}` : sent) : summary;
}
// A call can't wait on slow page reads: whatever details are on file by then are used.
const CALL_CONTEXT_WAIT_MS = 3000;

// Pure: the member-level rules a call carries, from memberRules(k) (services/memberKnowledge.ts). Discretion, grounding, member
// safety are already in the agent's prompt as those same shared constants (services/elevenLabsCalls.ts promptForElevenLabs); the
// two read from this member's state ride in here, per call: their quiet hours (in their zone, with where now sits) and restraint
// (holds, the unanswered pause, muted kinds, how they've been). The delivery-shape rule is for a delivery's text, not a call.
export function callRulesBlock(rules: Pick<MemberRules, "quietHours" | "restraint">): string | null {
  const lines = [rules.quietHours, rules.restraint].map((l) => l.trim()).filter(Boolean);
  return lines.length ? `What Co won't start on its own for them right now (what you say you'll send after the call lands inside these; what they ask for still goes):\n${lines.map((l) => `- ${l}`).join("\n")}` : null;
}

// Pure: what Co carries and has delivered (the layer's one carrying builder and delivered merge), as the lines collapseCarried
// reads. Promises are the after-call promise records (promise_result, the newest three); a handled one is "Sent." unless a
// delivery already covers it (then the delivery is what they have, said once). Deliveries are the documents they have.
export function callCarriedInputs(k: Pick<MemberKnowledge, "carrying" | "delivered">, zoneDay: (d: Date | string) => string): { promises: CarriedLine[]; delivered: Delivered[] } {
  const delivered: Delivered[] = k.delivered.filter((d) => d.kind === "document").slice(0, 12).map((d) => ({ title: d.what, at: d.at }));
  const promises = k.carrying
    .filter((c) => c.kind === "promise" && c.ref === null)
    .sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))
    .slice(0, 3)
    .map((c): CarriedLine => {
      const text = `${zoneDay(c.verifiedAt)}: Promised on the call: ${c.what}.`;
      if (c.state !== "done") return { text: `${text} Not sent yet.`, from: "promise", sent: false };
      const byDelivery = !collapseCarried([{ text: `${text} Not sent yet.`, from: "promise", sent: false }], delivered, zoneDay).open.length;
      return byDelivery ? { text: `${text} Not sent yet.`, from: "promise", sent: false } : { text: `${text} Sent.`, from: "promise", sent: true };
    });
  return { promises, delivered };
}

// A call's member-knowledge read, shared for a minute with the rest of the call's setup (the briefing reads their city from it
// rather than reading the layer again). A rejection is shared too: every reader catches it.
const KNOWLEDGE_SHARE_MS = 60_000;
const callKnowledgeReads = new Map<string, { at: number; k: Promise<MemberKnowledge> }>();
export function callKnowledgeInFlight(userId: string, now = Date.now()): Promise<MemberKnowledge> | null {
  for (const [u, v] of callKnowledgeReads) if (now - v.at > KNOWLEDGE_SHARE_MS) callKnowledgeReads.delete(u);
  return callKnowledgeReads.get(userId)?.k ?? null;
}
// A read the call won't wait past: it rejects at the wait, and the layer gives that section empty (never a made-up "no hold").
const withinWait = <T,>(p: Promise<T>, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} took longer than the call's wait`)), CALL_CONTEXT_WAIT_MS);
    t.unref?.();
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });

export async function buildCallKnowledge(userId: string): Promise<CallKnowledge> {
  // Both reads start before the first await, so the briefing (started right after this, services/callTrigger.ts) finds the
  // member-knowledge read already registered.
  // What was sent, with whatever details are on file by the wait (slow page reads never hold the call). One read: the layer's
  // delivered merge takes the same list (its offers loader is loadSentItems over the same 45 days).
  const sentItems = import("./turnContext.js").then((T) => T.loadSentItems(userId)).catch(() => [] as SentItem[]);
  // One member-knowledge read for the whole build (services/memberKnowledge.ts): stamped, member-stripped inside. Restraint (new on
  // this path) is held to the call's wait like every other slow read.
  const knowledge = import("./memberKnowledge.js").then((M) => M.memberKnowledge(userId, { include: CALL_KNOWLEDGE, ...CONTEXT_EXCHANGES }, { offers: () => sentItems, restraint: (u, at) => withinWait(M.realKnowledgeDeps.restraint(u, at), "the restraint read") }));
  callKnowledgeReads.set(userId, { at: Date.now(), k: knowledge });
  knowledge.catch(() => {});
  const { fillDetails, sentDetailLines } = await import("./turnContext.js");
  const [p, sent, callRows] = await Promise.all([
    loadContextParts(userId, CALL_KNOWLEDGE, {}, knowledge),
    Promise.race([
      sentItems.then(async (items) => {
        await fillDetails(items).catch(() => {});
        return items;
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CALL_CONTEXT_WAIT_MS)).then(() => sentItems),
    ]),
    // The last calls (transcripts and Co's [Call] summaries): call-only, not in the layer.
    pool
      .query(
        `SELECT created_at, memory_type, content FROM co_memories
         WHERE user_id = $1 AND created_at > NOW() - make_interval(days => $2)
           AND ((memory_type = 'call_transcript' AND length(content) > 300) OR (memory_type = 'text_exchange' AND content LIKE '[Call]%'))
         ORDER BY created_at DESC LIMIT 16`,
        [userId, LAST_CALLS_DAYS],
      )
      .then((r) => r.rows as { created_at: Date; memory_type: string; content: string }[])
      .catch(() => []),
  ]);
  const k = p.k;
  // Their zone (services/memberTime.ts, through the layer), or Pacific: every day and stamp in the briefing is theirs.
  const zone = k.identity.timeZone;
  // Co's own record of what it did (co_facts), for the after-call audit: the layer carries what Co sent, not this ledger.
  // Held to the call's wait: it only feeds the after-call audit.
  const ledgerLines = withinWait(import("./coFacts.js").then((F) => F.ledgerFacts(userId, "\n", k.identity.zone)), "the ledger read").then((l) => l.lines).catch(() => [] as string[]);
  // Another member's details stripped from every call-only part too
  // (memberSafeMemories.ts; 2026-10-01 call review: these bypassed it). The layer's parts are stripped inside it already; they go
  // through this strip again with the call's own name set (linked members and the names in their last suggestion).
  const { memberSafe } = memberSafeModule;
  const strip = async (xs: string[]) => (xs.length ? memberSafe(userId, xs.map((content) => ({ content, memory_type: "call_context" })), p.names) : []);
  const stripOne = async (x: string) => (await strip([x]))[0] ?? "";
  const corrections = p.corrections;
  const keep = (text: string, at?: Date | string | null) => !retiredBy(text, corrections, at);
  const now = new Date(k.asOf);

  // 1. What Co is carrying for them (open loops, the same as a text reply reads), each item once; what they already have apart.
  // What Co said on a call it would do, and what came of it (harness/callGrounding.ts), and what they have (delivery receipts and
  // Co's record of documents it sent), from the layer.
  const zoneDay = (d: Date | string) => dayLabel(d, zone);
  const { promises, delivered } = callCarriedInputs(k, zoneDay);
  const loopItems = p.model?.loops ? p.model.loops.replace(/^What you're carrying for them right now, and where each stands \([^)]*\): /, "").replace(/\.$/, "").split("; ") : [];
  const carried = collapseCarried([...promises, ...loopItems.map((l) => ({ text: l, from: "loop" as const }))], delivered, zoneDay);
  const promised = await strip(carried.open.filter((l) => l.from === "promise").map((l) => `- ${l.text}`));
  const loopLines = await strip(carried.open.filter((l) => l.from === "loop").map((l) => `- ${l.text.length > 240 ? `${l.text.slice(0, 240).replace(/[ ,;(]+[^ ,;(]*$/, "")}...` : l.text}`));
  const haveIt = (await strip(carried.theyHaveIt)).join("\n");
  // What Co says it will do on the call has to open something after it (#113: promises stay, but they get wired). At the cap
  // nothing new can open, so Co is told before it says it. The open tasks are the layer's (carrying: each with its task ref).
  // Each goal goes through the same member-safety strip as every other line here (review of #113).
  const openTasks = k.carrying.filter((c) => c.ref?.startsWith("task #"));
  const capacity = await import("./coTasks.js")
    .then(async (T) => {
      if (openTasks.length < T.TASK_LIMITS.maxOpen) return null;
      const goals = await strip(openTasks.map((t) => t.what.replace(/^Keep [^:]{0,40}: /, "")).slice(0, 5));
      return `You're already working on ${openTasks.length} things for them, the most you carry at once${goals.length ? ` (${goals.join("; ")})` : ""}. On this call, don't promise new work or say you'll keep an eye out for something new: nothing new can open. If they want something new, offer to drop one of these for it.`;
    })
    .catch(() => null);
  const loops = [
    capacity,
    promised.length ? `What you said on a call you'd do, still open:\n${promised.join("\n")}` : null,
    loopLines.length ? `What you're carrying for them and where each stands (say where one stands when they ask what you're doing or when it changes what they should do next; what you already told them on a call isn't news, and it never opens a call):\n${loopLines.join("\n")}` : null,
  ].filter(Boolean).join("\n");
  // 2. The last calls: Co's own summary of each (or their first words on it), names as corrected.
  const pastCalls = pairCalls(callRows);
  const calls = await Promise.all(pastCalls.map(async (c) => ({ ...c, summary: c.summary ? withCorrectedNames(await stripOne(c.summary), corrections) || null : null, theirWords: (await strip(c.theirWords)).map((w) => withCorrectedNames(w, corrections)) })));
  // A past call's sentence about something they already have (the doc that "will be sent") is not repeated as a pickup.
  const lastCalls = renderLastCalls(calls.map((c) => ({ ...c, summary: c.summary ? c.summary.split(/(?<=[.!?])\s+/).filter((x) => !carried.covered(x)).join(" ") || null : null })), now, zone);
  // 3 and 7. Their open threads, newest first, stamped; corrected ones dropped.
  const threadList = [...(p.model?.threadList ?? [])].sort((a, b) => +new Date(b.lastTouchedAt ?? b.openedAt) - +new Date(a.lastTouchedAt ?? a.openedAt));
  const stamped = threadList
    .filter((t) => keep(t.text, t.lastTouchedAt ?? t.openedAt) && !carried.covered(t.text))
    .map((t) => ({ t, st: stampOf({ saidOn: t.openedAt, confirmedOn: t.lastTouchedAt, dueOn: t.dueDate }, now, zone) }))
    .filter((x) => !x.st.drop)
    .map((x) => `${x.t.text} (${x.st.label})`);
  const threads = (await strip(stamped)).map((text) => ({ text, line: text }));
  // 4. Settled.
  const settled = renderSettled(corrections, zone);
  // 5. Lessons (the layer's: times they corrected Co's manner).
  const lessons = await strip(k.lessons.map((l) => l.text));
  // 6. The rest, with corrected goals, wants and recap sentences left out. The member rules lead it: short, and read every call.
  const { memberRules } = await import("./memberKnowledge.js");
  const rules = callRulesBlock(memberRules(k));
  const recap = p.recap ? withCorrectedNames(p.recap.text.split(/(?<=[.!?])\s+/).filter((s) => keep(s, p.recap!.at) && !carried.covered(s)).join(" "), corrections) : "";
  const who = p.model?.who ? await stripOne(p.model.who) : "";
  // Their own words lately, newest kept first within a bound (a pasted screenshot can run long), one paragraph.
  const theirWords: string[] = [];
  let wordsUsed = 0;
  for (const l of [...p.ownWords].filter((x) => !/^\[Call\]/.test(x)).reverse()) {
    const flat = l.replace(/\s*\n+\s*/g, " ").slice(0, 300);
    if (wordsUsed + flat.length > 900) break;
    theirWords.unshift(flat);
    wordsUsed += flat.length + 1;
  }
  const base = [
    rules,
    who ? `Who they are:\n${who}` : null,
    theirWords.length ? `What they've told you in the last two days (newest facts win over anything below):\n${theirWords.join("\n")}` : null,
    p.openAsks.length ? `What they're looking for right now:\n${p.openAsks.join("\n")}` : null,
    recap ? `Ongoing summary: ${recap}` : null,
    ...profileLines(p, (t) => keep(t)),
    p.recentTexts.length ? `Recent texts: ${[...p.recentTexts].filter((x) => !/^\[Call\]/.test(x)).reverse().join(" / ")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const sentLines = await strip(sentDetailLines({ sent }, 7));
  const summary = assembleCallSummary({ haveIt: haveIt || null, now: loops || null, lastCalls: lastCalls || null, settled: settled || null, lessons, sentLines, threads, base });

  const ledger = await strip(await ledgerLines);
  const facts = [
    ...sentLines,
    ...ledger,
    ...k.asks.slice(0, 8).map((a) => `They've asked Co for (their words): "${a.text}"`),
  ].join("\n");
  // Impressions: what Co's models wrote about them (never proof of a specific fact).
  const impressions = [who, lastCalls, recap, threads.map((t) => t.text).join("\n"), p.emotionalLine ?? ""].filter(Boolean).join("\n\n");
  return { summary, facts, impressions };
}

// The summary a call opens with.
// When nothing about them could be read (the member-knowledge layer rejects when the names to strip can't be read, and the plain
// summary fails the same way), a call still knows it isn't a first conversation: an empty summary reads as "your first real
// conversation" in the agent's prompt (services/elevenLabsCalls.ts CALL_CONTEXT_BLOCK), and an existing member got intake (review
// of #122). No facts in it, so nothing to strip.
export const CALL_NOTES_UNAVAILABLE = "Your notes on them didn't load for this call. This is not a first conversation: don't introduce yourself or run intake; ask what's on their mind and follow them.";

export async function buildCallContextSummary(userId: string): Promise<string> {
  try {
    return (await buildCallKnowledge(userId)).summary;
  } catch (err: any) {
    console.error("callContext: buildCallContextSummary failed (non-fatal, using the plain summary):", err?.message ?? err);
    try {
      return await contextSummary(userId);
    } catch (err2: any) {
      console.error("callContext: the plain summary failed too (calling with no notes, not as a first conversation):", err2?.message ?? err2);
      return CALL_NOTES_UNAVAILABLE;
    }
  }
}

// The other direction of the same bridge — closes a real gap (Royce,
// 2026-09-07: "anything overlapping that may cause confusion... between
// voice and text?"): routes/sendblue.ts's recentConversation, read by every
// text-reply classifier, only ever queries co_memories.text_exchange rows,
// never call_transcript — and the only other channel-bridging mechanism is
// memoryCompaction.ts's recap, which runs once a day at 4am. Without this, a
// text reply arriving the SAME DAY as a call had zero visibility into what
// was just discussed until the next day's recap. Written as its own
// text_exchange row (not call_transcript) specifically so it's picked up by
// that same existing query with no changes needed there. Best-effort,
// call-ending pipeline continues regardless — matches storeProfile's own
// non-blocking Step 7 siblings (captureIntent, extractPlannedEventMention).
// Exported for evals (2026-09-23): a real summary dropped both partnerships
// the member named (Lythe.ai, Sangria) and read a voice score as "may have
// wanted to continue" when their last words were "we can close out good".
export function callSummaryPrompt(transcript: string): string {
  return `Summarize what was actually discussed in this phone call transcript, in 2-3 plain sentences, third person, as if briefing someone on what just happened. Ground it only in what's actually in the transcript — no invented detail, no therapy-speak. Write the person on the call as {M} every time, never a pronoun for them (no he, she, they, his, her, their): "{M} is building...", "{M}'s cofounder". We fill in their name. Refer to anyone else by that person's own name (2026-09-22: summaries were calling a member "he" from their name alone).

Names of companies and people come from what THEY said (the "user:" lines), never from the assistant's lines: when the assistant says a different name than the member did ("Bumble" for the member's "Boardy"), the member's wins, because the assistant can mishear. A name the member said and speech-to-text garbled ("Boredy") is written as the real company when it is plain which one.

Lead with the concrete facts they gave: the names of companies, people, places, dates, and plans, spelled as they said them. Speech-to-text often spells names out letter by letter ("l y t h e dot a i" is lythe.ai); write the name, not the letters. Keep every named company and person they mentioned.

How the call ended comes only from what they said at the end, never from a voice reading. Don't say they wanted to keep talking unless they said so.

Transcript:
"${transcript}"
Return ONLY the summary, no preamble.`;
}

// "They" for the member only, never for anyone else (code review,
// 2026-09-24, twice). Blanket neutralizing turned "Royce talked about Maya.
// She is leaving the company." into "They are leaving", pinning Maya's news
// on the member; a first fix guessed people from capital letters and
// keywords and got it wrong the other way. Now it follows who the summary is
// talking about, in order: the member (by name, and at the start), another
// named person, or a singular relation ("his cofounder", "her mom"). A
// gendered pronoun is rewritten only when the last person mentioned before
// it is the member; when unsure it's left alone, because a stray "he" about
// the member is a smaller harm than someone else's news said about them.
const NOT_A_NAME = new Set(
  "co hume i the a an they their them he she his her it its this that these those we you our and but so then also overall monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split(" "),
);
const RELATION_ONE = /^(co-?founder|partner|wife|husband|girlfriend|boyfriend|fianc[eé]e?|mom|mother|dad|father|sister|brother|friend|boss|manager|colleague|coworker|son|daughter|roommate|investor|ceo|cto|founder|mentor|client|cousin|aunt|uncle)$/i;
// "her" before one of these is the object ("give her a call", "told her about it"), not "their".
const OBJECT_NEXT = /^\s+(a|an|the|to|for|in|on|at|about|up|out|back|some|any|one|this|that|it|with|from|into|over|and|or|but|so|if|when|how|what|why)\b/i;
// Common verbs a he/she took an -s on: "he loves it" becomes "they love it", not "they loves it".
const S_VERBS = "loves|likes|wants|needs|thinks|says|works|runs|plans|hopes|feels|sounds|starts|knows|believes|mentioned|builds|leads|helps|asks|tells|seems|looks|lives|gets|takes|makes|goes|wishes|prefers|enjoys|expects|worries|runs|owns|hosts|joins";
const SINGULAR_VERB = new RegExp(`\\b(they)\\s+(${S_VERBS})\\b`, "gi");
const PRONOUN = /\b(he|she)\s+(is|was|has)\b|\b(he|she)'s\b|\b(himself|herself)\b|\b(his|hers)\b|\bher(?=\s+[a-z])|\b(him|her)\b|\b(he|she)\b/gi;
function neutralOne(m: string): string {
  const out = m
    .replace(/^(he|she)\s+is$/i, "they are")
    .replace(/^(he|she)\s+was$/i, "they were")
    .replace(/^(he|she)\s+has$/i, "they have")
    .replace(/^(he|she)'s$/i, "they're")
    .replace(/^(himself|herself)$/i, "themself")
    .replace(/^(his|hers)$/i, "their")
    .replace(/^(him)$/i, "them")
    .replace(/^(he|she)$/i, "they");
  return m[0] === m[0].toUpperCase() ? out[0].toUpperCase() + out.slice(1) : out;
}
export function neutralMemberPronouns(text: string, memberFirstName: string | null): string {
  const memberParts = (memberFirstName ?? "").split(/\s+/).filter(Boolean).map((n) => n.toLowerCase());
  // Only a capitalised word names the member: "will" and "may" are verbs, not a member called Will or May.
  const isMember = (w: string) => /^[A-Z]/.test(w) && memberParts.includes(w.toLowerCase().replace(/'s$/, ""));
  // A capitalized word at the start of a sentence is only a person if it's
  // also capitalized somewhere mid-sentence ("Mentioned his startup..." isn't).
  const midSentenceCaps = new Set(
    [...text.matchAll(/(?<![.!?]\s*|^\s*)\b([A-Z][A-Za-z'-]*[a-z])\b/g)].map((m) => m[1].toLowerCase().replace(/'s$/, "")),
  );
  type Ref = { at: number; member: boolean };
  const refs: Ref[] = [];
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z'.-]*[A-Za-z]\b/g)) {
    const word = m[0];
    const bare = word.toLowerCase().replace(/'s$/, "");
    if (isMember(word)) refs.push({ at: m.index!, member: true });
    else if (RELATION_ONE.test(bare)) refs.push({ at: m.index!, member: false });
    else if (/^[A-Z]/.test(word) && !NOT_A_NAME.has(bare) && !/\./.test(word)) {
      const before = text.slice(0, m.index!);
      const atSentenceStart = /(^|[.!?]\s+)$/.test(before);
      // "at Sangria", "in San Francisco", "from Austin": places and companies.
      // Not "about/for/to/with", where people's names go.
      const placeOrCompany = /\b(at|in|from|near|into)\s+(the\s+)?([A-Z][\w'&-]*\s+)*$/.test(before);
      if ((!atSentenceStart || midSentenceCaps.has(bare)) && !placeOrCompany) refs.push({ at: m.index!, member: false });
    }
  }
  const aboutMemberAt = (i: number) => {
    let last: Ref | null = null;
    for (const r of refs) if (r.at < i) last = r;
    return last ? last.member : true; // a summary starts out about the member
  };
  return text.replace(PRONOUN, (m, ...args) => {
    const at = args[args.length - 2] as number;
    const full = args[args.length - 1] as string;
    if (!aboutMemberAt(at)) return m;
    if (/^her$/i.test(m)) {
      const next = full.slice(at + 3);
      const possessive = /^\s+[a-z]/.test(next) && !OBJECT_NEXT.test(next);
      const word = possessive ? "their" : "them";
      return m[0] === "H" ? word[0].toUpperCase() + word.slice(1) : word;
    }
    return neutralOne(m);
  }).replace(SINGULAR_VERB, (_m, they, verb) => `${they} ${verb.replace(/ies$/i, "y").replace(/(ches|shes|sses|xes|oes)$/i, (x: string) => x.slice(0, -2)).replace(/s$/i, "")}`);
}

// The member is written as {M} (second review, 2026-09-24: the model used
// "he" for the member despite being told not to, and no rule can reliably
// tell whose "he" it is once someone else is mentioned). With {M} for the
// member, a leftover he/she can only be someone else; the pronoun rule
// above stays as a backup for a summary that slipped.
export function fillMemberName(text: string, memberFirstName: string | null): string {
  // With no name on file, "The member" keeps the grammar ("The member is building...", "The member's cofounder"),
  // where a bare "They" gave "They is building".
  const name = memberFirstName?.trim() || "The member";
  const M = /\{\s*M\s*\}/gi;
  // "{M}self" came back as "Royceself" in testing; that one is "themself".
  const filled = text.replace(/\{\s*M\s*\}self\b/gi, "themself").replace(new RegExp(M.source + "('s)?", "gi"), (_m, poss) => (poss ? `${name}'s` : name));
  return neutralMemberPronouns(filled, memberFirstName);
}

export async function summarizeCallForTextContext(userId: string, transcript: string): Promise<void> {
  try {
    const { text: raw } = await generateText({
      model: anthropic(SUMMARY_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "callContext.summarizeCallForText" },
      prompt: callSummaryPrompt(transcript),
    });
    // The prompt already says "they"; the model still wrote "he" on all
    // three runs of a real call (2026-09-23), so it's enforced in code.
    const firstName = await pool
      .query(`SELECT first_name FROM users WHERE id = $1`, [userId])
      .then((r) => (r.rows[0]?.first_name as string | undefined) ?? null)
      .catch(() => null);
    const summary = fillMemberName(raw.trim(), firstName);
    if (!summary) return;
    await writeMemory(userId, "text_exchange", `[Call] ${summary}`);
  } catch (err: any) {
    console.error("summarizeCallForTextContext: failed (non-fatal):", err?.message ?? err);
  }
}
