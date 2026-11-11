// A reply uses what its own search found (Royce, 2026-10-17, standing direction: "Every find Cue sends, in a reply or on its own,
// goes out as its link, then a one-line caption. Never prose that names a find without its link."). On 10-17 "Anything you have for
// me in SF?" found real SF events (Builders who Run SF among them), and the reply said "Weekend's thin on the founder/builder side
// right now", then later named a find in prose with no link. The fact check only asks whether a claim is true, never whether the
// reply ignored what it just found; these do. Co decides; code guards the facts: what this turn's search returned, what was sent.
// Pure; agent/conversationTools.ts sendReply acts on them once per turn, while the agent can still use shareFinds.
import { meaningWords } from "../services/profileExtraction.js";
import type { Found } from "./loopTools.js";

// This turn's finds: returned by a search this turn (not carried in from an earlier one), not turned away, with a name and a link.
export function turnFinds(found: Iterable<Found>): Found[] {
  return [...found].filter((f) => !f.stored && !f.blocked && !!f.match && !!f.name && /^https?:\/\//.test(f.url));
}

const norm = (t: string) => t.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
// Words of a find's name that say which find it is (not "SF", "the", "night", ...).
const COMMON = new Set(["sf", "san", "francisco", "night", "nights", "event", "events", "party", "dinner", "meetup", "club", "the", "and", "with", "for", "at", "of", "in", "x", "a", "an", "on", "to", "conference", "festival", "show", "talk", "session", "sessions"]);
export const isPost = (f: Pick<Found, "name"> & { url?: string; match?: Found["match"] }) => (f.match as any)?.source === "x" || (!!f.url && /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(f.url));
const nameWords = (name: string) => [...meaningWords(name)].filter((w) => w.length > 2 && !COMMON.has(w));

// Pure: does the text name this find? Its full name, or (for a longer name) at least two of its distinguishing words.
export function namesFind(text: string, f: Pick<Found, "name"> & { url?: string; match?: Found["match"] }): boolean {
  const t = norm(text);
  const n = norm(f.name).replace(/\s*(?:[—–|]|\s-\s).*$/, "").trim();
  if (n.length >= 6 && t.includes(n)) return true;
  // An X post's "name" is its opening prose: two shared words is talk about the same subject, not naming it (review of this change).
  if (isPost(f)) return false;
  // A web page's site name after " | " isn't the find's name ("Founder Dinner Series | San Francisco Startup Community").
  const words = nameWords(f.name.replace(/\s+\|\s+.*$/, ""));
  if (!words.length) return false;
  const have = meaningWords(text);
  const hits = words.filter((w) => have.has(w)).length;
  return words.length === 1 ? hits === 1 && n.length >= 6 && t.includes(n.split(" ")[0]) : hits >= 2;
}

// Pure: the finds this reply names in prose without their link (not sent this turn with shareFinds, and no link of theirs in it).
export function unlinkedFinds(draft: string, finds: Found[], shared: string[]): Found[] {
  return finds.filter((f) => !shared.includes(f.url) && !draft.includes(f.url) && namesFind(draft, f));
}

// "Thin", "nothing", "no luck": a reply saying there's little or nothing to offer.
export const NOTHING_SAID = /\b(?:(?:it'?s|is|looks|looking|pretty|kind of|kinda|a bit|really)\s+(?:thin|slim|quiet|dry|sparse|light)|thin (?:on|right now|this|out there)|slim pickings|not much (?:out there|going on|happening|on|this)|nothing (?:much|good|great|solid|real|that fits|that stands out|came up|turned up|jumped out|on|going on|happening|this weekend|this week)|no luck|came up (?:empty|short|dry)|(?:didn't|couldn't|did not|could not) find (?:anything|much)|nothing'?s (?:on|happening|going on|out there))\b/i;

// Pure: the reply says there's little or nothing while this turn's search found things and none of them went out. Once some went
// out, "nothing else fits" is an honest filter, never pushed for more (review of this change: three real options beat ten maybes).
export function ignoresFinds(draft: string, finds: Found[], shared: string[]): boolean {
  return !shared.length && finds.length > 0 && NOTHING_SAID.test(draft);
}

// The one redraft note, naming what was found (a few, by name and link) and what to do with them.
// A past find they're asking for again (2026-11-10 paid run: "what was the wine bar you sent?" got its name, no link): their message asks
// for it, and isn't telling Cue a link was wrong (then the old link is never pushed again).
export const REASKS_FIND = /\b(?:what was|which (?:one|was|bar|place|event|program)|send (?:me )?(?:it|that|the link)|the link|link (?:again|to)|again|resend|re-send|share (?:it|that))\b/i;
export const SAYS_LINK_WRONG = /\b(?:wrong|not the|isn'?t the|wasn'?t the|was a roundup|broken|dead|doesn'?t (?:work|load|open)|didn'?t (?:work|load|open))\b/i;
// A decision question and a "why it fits" question about finds Cue sent (agent/conversationReply.ts DECISION_LINE, FIT_LINE; Royce,
// 2026-11-11). Here because the past-find link guard below reads DECISION_ASK too; conversationReply.ts re-exports both.
export const DECISION_ASK = /\b(?:best (?:option|one|bet|pick|choice)|which (?:one|of (?:these|those|them|the)\b|(?:is|would be|sounds) better)|(?:should|do) i (?:go(?: to)?|pick|choose|hit) (?![^?.!]*\bor not\b)[^?.!]{1,80}\bor\b|pick (?:one )?for me|choose for me|what would you (?:pick|choose|go (?:with|to)|do)|if you were me|(?:is|are) (?:it|this|that|they|the [\w'-]+(?: [\w'-]+)?) worth (?:it|going|the trip|my time)\b)|^\s*(?:the )?[\w'&-]+(?: [\w'&-]+){0,3} or (?!not\b)(?:the )?[\w'&-]+(?: [\w'&-]+){0,3}\s*\?\s*$/i;
export const FIT_ASK = /\bwhy (?:it|this|that)(?: one)? (?:fits|works|makes sense|is (?:a )?(?:good )?(?:fit|pick))\b|\bwhy (?:is )?(?:it|this|that)(?: one)? (?:for|right for) me\b|\bhow (?:does )?(?:it|this|that) fit\b|\bwhy (?:does|would) (?:it|this|that)(?: one)? (?:fit|suit|work for)\b|\b(?:is |how is |why is )?(?:it|this|that)(?: one)? relevant (?:to|for) me\b|\brelevant to me\b|\bwhy (?:should|would) i go\b|\bwhy (?:this|that) one\b/i;
// Pure: the past finds they refer to that the draft names with no link gone this turn (or riding in it). A decision ask counts when the
// draft names exactly one of them (2026-11-11, std-best-option-this-week: the pick went without its link; DECISION_LINE asks for it):
// naming two or more is a comparison, not a pick, and no link is pushed.
export function unlinkedPastFinds(draft: string, message: string, referents: readonly { name: string; url: string | null }[], linksThisTurn: readonly string[]): { name: string; url: string }[] {
  if (SAYS_LINK_WRONG.test(message)) return [];
  const reasks = REASKS_FIND.test(message);
  if (!reasks && !DECISION_ASK.test(message)) return [];
  const named = referents
    .filter((x): x is { name: string; url: string } => !!x.url && /^https?:\/\//.test(x.url))
    .filter((x) => namesFind(draft, { name: x.name, url: x.url }));
  if (!reasks && named.length !== 1) return [];
  return named.filter((x) => !draft.includes(x.url) && !linksThisTurn.some((l) => l.includes(x.url)));
}

export function findsRedraftNote(kind: "unlinked" | "ignored" | "emptied" | "unlinked_sent", finds: Found[], shared: string[]): string {
  const left = finds.filter((f) => !shared.includes(f.url)).slice(0, 6);
  const list = left.map((f) => `"${f.name.slice(0, 80)}" (${f.url})`).join("; ");
  if (kind === "unlinked_sent") return `Not sent: they asked about something you sent them before, and this names it without its link. Send its link first with shareLink (the link, then a short line), then nothing that repeats it. Sent before: ${list}.`;
  const send = "Send each one you mean with shareFinds (its link, then a one-line caption), then a short reply that doesn't repeat them.";
  if (kind === "unlinked") return `Not sent: it names something your search found this turn without its link. Every find goes out as its link, then a one-line caption, never in prose. ${send} Found this turn: ${list}.`;
  if (kind === "ignored") return `Not sent: it says there's little or nothing, but your search found these this turn: ${list}. Send what fits with shareFinds (each its link, then a one-line caption), or say plainly why none of them fit. Never call it thin while finds are waiting.`;
  return `Nothing was left after the fact check, and nothing has gone to them yet but the holding line: they're still waiting. Your search found these this turn: ${list}. ${send} Only what's on their pages or in their results.`;
}

// ---------- the meaning read (Royce, 2026-10-17: "the guards match words, not meaning"). The words above miss "Not a lot going on this
// weekend" and a find named loosely ("Caterina's festival", "the Nathan Fielder screening"): measured 7 of 8 and 5 of 7 missed. One
// small Haiku read answers both, only when the words found nothing, this turn's search found things, and none has gone out yet (the
// 10-17 case). A read that fails or can't be parsed decides nothing: the draft goes on as the words left it.
export type FindUse = { named: number[]; saysNothing: boolean };
// At most this many reads a turn (third review, 2026-10-17): one let a clean first send use it up, and a second "Not a lot going on in
// SF this weekend though." went unread while finds waited. A flagged read ends the reads anyway (one redraft a turn).
export const FIND_READS_PER_TURN = 2;
export type FindUseRead = (draft: string, finds: (Pick<Found, "name"> & { facts?: string })[]) => Promise<FindUse | null>;

// A find's own name, then a short line of what's known about it (the place, the host, what it is), so a find named by what it is
// ("the Nathan Fielder screening") reads as named.
const aboutLine = (f: Pick<Found, "name"> & { facts?: string }) => {
  const about = (f.facts ?? "").split(f.name).join("it").replace(/\s+/g, " ").trim().slice(0, 220);
  return about ? `${f.name} (${about})` : f.name;
};

export function findUsePrompt(draft: string, finds: (Pick<Found, "name"> & { facts?: string })[]): string {
  return `Cue, a texting companion, searched for things for a member and found these:
${finds.map((f, i) => `${i + 1}. ${aboutLine(f)}`).join("\n")}

Here is the text Cue is about to send them:
"""${draft.slice(0, 1200)}"""

1. Which of the numbered finds does the text name or clearly refer to, even loosely (a nickname, the host or organizer, the place, or what it is)? Only ones it really points at: a general kind of thing ("a run", "a dinner") that isn't clearly one of these doesn't count, and neither does "these" or "them" about the finds as a group.
2. Does the text say or imply there's little or nothing worth doing, or nothing that fits them (for example "not a lot going on", "pretty quiet out there", "nothing jumping out")? A question, or an offer to look for something else, is not that.

Return ONLY JSON: {"named": [numbers], "saysNothing": true or false}`;
}

// Pure: the read's answer, or null when it isn't one.
export function parseFindUse(raw: string, n: number): FindUse | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (!Array.isArray(j.named) || typeof j.saysNothing !== "boolean") return null;
    return { named: [...new Set(j.named.map(Number).filter((x: number) => Number.isInteger(x) && x >= 1 && x <= n))] as number[], saysNothing: j.saysNothing };
  } catch {
    return null;
  }
}

export const realFindUseRead: FindUseRead = async (draft, finds) => {
  try {
    const [{ generateText }, { anthropic }, { MODELS }] = await Promise.all([import("ai"), import("@ai-sdk/anthropic"), import("../models.js")]);
    const { text } = await generateText({
      model: anthropic(MODELS.haiku),
      maxOutputTokens: 120,
      abortSignal: AbortSignal.timeout(6_000),
      experimental_telemetry: { isEnabled: true, functionId: "reply.findUse", recordInputs: false, recordOutputs: false },
      prompt: findUsePrompt(draft, finds),
    });
    return parseFindUse(text, finds.length);
  } catch {
    return null;
  }
};
