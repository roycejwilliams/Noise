// One composer per proactive bundle (Royce, 2026-10-10, Phase C). A bundle of finds used to be stitched by one line of code from
// blind parts: each caption drafted alone (told "Co is reaching out first", "one message, one reason", even the second and third),
// then a closing question written from the names only, with stock lines as its fallback. No part saw the others, the thread, or why
// Co's pick chose them, so the same reason could repeat three times and a find could land on top of a live conversation.
//
// Now one model call, given the member record, the thread, every find with its facts and the pick's own why, and the pick's view of
// the day's set, writes the whole message: each find on its own, its link then its own caption, never grouped; then, when there's more
// than one, Co's own line tying them back to what the member is going through (kept in the "opening" field, sent after the last find,
// Royce 2026-10-13); and the closing question that comes out of what it just said (C1-C3, C5). Quality control is inside (C4): code
// checks every part, and anything wrong goes back to the composer as one bundle, never as a lone redraft of one part. A find that can't
// be said well is taken out and the rest is composed again, so no caption is ever sent that was written for a different set. There is
// no stock closing line: a closing that doesn't hold up is left out.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { CO_TEXT_CHANNEL, CO_VOICE } from "../services/coVoice.js";
import { brandSafe } from "../services/brandGuard.js";
import { cleanCoMessage } from "../services/sendblue.js";
import { capitalizeSentences } from "../services/textStyle.js";
import { IDENTITY_RULE, stripUngroundedIdentity } from "../services/identityGuard.js";
import { OFFER_FOLLOWUP_MANY, OFFER_FOLLOWUP_ONE, stripClosingQuestion } from "../services/offerFollowUp.js";
import { CO_WHY } from "../services/coVoice.js";
import { unbackedSpecifics } from "./proactiveSpecifics.js";
import { repeatQuestionCheck } from "./repeatAsk.js";
import type { RevealItem } from "../agent/eventDiscoverySurfacing.js";
import { AUDIENCE_RULE, OFFER_HONESTY, REVEAL_MAX_CHARS, ROUNDUP_NOTE, VERIFIED_CLAIM } from "../agent/eventDiscoverySurfacing.js";
export { ROUNDUP_NOTE, VERIFIED_CLAIM };
import { checkDraft, DRAFT_MODEL, renderFacts, type Candidate } from "./proactive.js";

// A caption carries what the thing is, the benefit its facts support and the limit that matters (Royce, 2026-11-11), so it may run to
// three sentences; the single reveal keeps its own limit (REVEAL_MAX_CHARS).
export const BUNDLE_LIMITS = { openingChars: 280, closingChars: 140, captionChars: REVEAL_MAX_CHARS + 120, captionSentences: 3, calls: 3 } as const;

// The pick's own reading of one find (services/sweepSelect.ts): why it's for this member, and why now. Null for a find that didn't come
// through the pick.
export type PickWhy = { whyMember: string; whyNow: string } | null;
// tierPick: the best of its tier for them this morning (services/sweepSelect.ts tierPicks): never skipped for fit (composeBundle).
// againWhy: why a resend comes back (harness/matchGate.ts repeatRule): never answered or talked about in a month, or what changed.
export type BundleItem = { candidate: Candidate; item: RevealItem; pick: PickWhy; again: boolean; againWhy?: string | null; tierPick?: boolean };
export type ComposeInput = {
  firstName: string;
  items: BundleItem[];
  // The pick's view of the day's set: why these go together today (services/sweepSelect.ts "set"), or null.
  set: string | null;
  // Why the dispatch put the first one first (choosePick or the expiring-find rule), or null.
  leadWhy: string | null;
  // What Co knows about them (memberDraftBlock), and how they've been.
  memberBlock: string | null;
  feeling: string | null;
  // The recent thread, stamped in their zone, and as stored (for the repeat-question check).
  thread: string;
  recent: string;
  // A fact, in code: they wrote to Co within the last LIVE_MINUTES (dispatch reads it from the record).
  threadLive: boolean;
  // Whether waiting is still possible (dispatch, in code: few enough waits so far, and nothing in the bundle expires in the next
  // hour). When it isn't, a live thread is acknowledged rather than waited on (review of #135: waits could loop and expire finds).
  mayWait?: boolean;
};
export type ComposeDeps = { model: (prompt: string) => Promise<string> };
export const realComposeDeps: ComposeDeps = {
  // Bounded, so three tries in a row can't hold a dispatch worker (review of #135).
  model: async (prompt) => (await generateText({ model: anthropic(DRAFT_MODEL), maxOutputTokens: 4000, providerOptions: { anthropic: { effort: "medium" } }, abortSignal: AbortSignal.timeout(45_000), experimental_telemetry: { isEnabled: true, functionId: "proactive.bundleComposer" }, prompt })).text,
};
// The closing line's guardrail, in code (Royce, 2026-10-13: "never invent a feeling or a situation, never label who someone is"): a
// fail-safe read of the line against what Co knows about them. It keeps the line only when everything it says about them (a feeling, a
// situation, who they are) is backed by what's known; anything else, or a read that fails, and the line is left out. Pure prompt +
// parse; the model is the caller's.
export function closingLinePrompt(line: string, known: string): string {
  return `A text Cue is about to send ends with this line about the member:
"${line}"

What Cue knows about them (their own words, their record, how they've been):
${known.trim() || "(nothing)"}

Does the line state any feeling, situation, event in their life, or label of who they are (identity, role, status) that what Cue knows does not back? Saying what the finds are for, or a gentle general warmth, is fine. A feeling or situation it states about THEM must be backed.
Return ONLY JSON: {"backed": true or false, "why": "a few words"}`;
}
export function readClosingJudgment(raw: string): { backed: boolean; why: string } {
  const m = raw.match(/\{[\s\S]*\}/);
  try {
    const j = m ? JSON.parse(m[0]) : null;
    return { backed: j?.backed === true, why: typeof j?.why === "string" ? j.why.slice(0, 200) : "no reason given" };
  } catch {
    return { backed: false, why: "the read couldn't be parsed" };
  }
}

export const LIVE_MINUTES = 45;

export type Composed = {
  messages: string[];
  // The words Co wrote, joined (for payload first, the ledger and the log).
  text: string;
  included: BundleItem[];
  // tierSkipped: a morning tier pick the composer still skipped after being told it goes (dispatch queues its tier's next best).
  dropped: { item: BundleItem; why: string; tierSkipped?: boolean }[];
  opening: string | null;
  closing: string | null;
  // Each included thing's own messages (its link and its caption), in order, for the send ledger.
  perItem: { candidate: Candidate; messages: string[] }[];
  calls: number;
  notes: string[];
};
export type ComposeResult = Composed | { wait: string; calls: number } | { fail: string; leadSkipped?: boolean; tierSkipped?: boolean; calls: number; notes: string[] };

// ---------------------------------------------------------------- set and wait (pure)

// The pick's set line, only when the bundle is exactly the finds it chose together (more than one).
export function setFor(items: BundleItem[]): string | null {
  if (items.length < 2) return null;
  const picks = items.map((b) => (b.candidate.payload as { pick?: { set?: string | null; setKeys?: string[] } })?.pick);
  const first = picks[0];
  if (!first?.set || !first.setKeys?.length) return null;
  const keys = new Set(items.map((b) => b.candidate.targetKey));
  const same = first.setKeys.length === keys.size && first.setKeys.every((k) => keys.has(k)) && picks.every((p) => p?.set === first.set);
  return same ? first.set : null;
}

// Waiting on a live conversation is possible while no find in the bundle has waited MAX_WAITS times and none expires within the hour.
export const MAX_WAITS = 3;
export function mayWait(items: { waits: number; expiresAt: Date | null }[], now: Date): boolean {
  return items.every((x) => x.waits < MAX_WAITS && (!x.expiresAt || x.expiresAt.getTime() - now.getTime() > 3_600_000));
}

// ---------------------------------------------------------------- the prompt (pure)

// The roundup note and the unchecked-claim pattern live with the reveal (agent/eventDiscoverySurfacing.ts), shared by every path.
// A caption that presents a resend as a fresh find.
export const NEW_CLAIM = /\b(?:new (?:find|one|program|opportunity|opening)|just (?:found|came across|spotted|saw)|came across|found (?:this|another|one)|another (?:one|program|residency|fellowship|opening)|distinct from|different from (?:the|what)|not the same as)\b/i;

// Pure: how a resend is framed (Royce, 2026-11-10: the 11-10 resend was captioned as a new find). It was sent before: never new, never
// "another" or "distinct". A change is said as the change; otherwise one light circle-back.
export function againNote(why: string | null | undefined): string {
  return why && /^changed since/.test(why)
    ? ` (you sent this before; it ${why.replace(/^changed since it was shown/, "changed since you sent it")}: lead with what changed, never present it as new)`
    : " (you sent this before, over a month ago, and it wasn't answered or talked about since; it's still open: circle back once, lightly, never as new)";
}

export function composePrompt(i: ComposeInput, o: { problems?: string[]; last?: string | null } = {}): string {
  const many = i.items.length > 1;
  const items = i.items
    .map((b, n) => {
      const pick = b.pick ? `\nCue's daily pick's read (a lead to check against its facts, never a fact and never words to repeat): ${b.pick.whyMember}${b.pick.whyNow ? `\nwhy now, as the pick saw it: ${b.pick.whyNow}` : ""}` : "";
      return `THING ${n + 1}${n === 0 ? " (it leads)" : ""}${b.tierPick ? " (the best of its kind for them this morning: it goes; never skip it for fit, caption it from its own facts)" : ""}${b.item.url ? " (its link goes out as its own message right before your caption)" : ""}${b.item.shortNotice ? " (short notice: say so plainly, no pressure)" : ""}${b.again ? againNote(b.againWhy) : ""}${b.item.roundup ? ROUNDUP_NOTE : ""}\n${renderFacts(b.item.facts)}${pick}`;
    })
    .join("\n\n");
  return `${CO_VOICE}

${CO_TEXT_CHANNEL} You're texting ${i.firstName}. Cue is reaching out first with ${many ? `${i.items.length} things, each its own link and description` : "one thing"}.

HOW IT GOES OUT
- No opening line: nothing before the first thing. Each thing stands on its own, its link then its description (Royce, 2026-10-13: "each tier found should get a link then a description. Never clump them up together").\n- Then, for each thing in order: its link (sent for you, as its own message) and your caption under it. Each caption names the thing and when it is, says what it actually is from its facts (what happens there, who it's for as its page says it), and the one benefit those facts support for something they're in the middle of now, with the limit that matters. ${CO_WHY}
- Each caption describes its own thing only, in its own words: what it is and why it fits them. Never mention, compare with or group it with the other things, and never repeat another caption's reason.
${many ? "- After the last thing, end with your own line (it goes in \"opening\"): you know them, what they're going through and how they've been, so say what these mean for them now, however you'd say it. Your call, in Cue's voice. Ground it in what you actually know about them below; never invent a feeling or a situation, and never name what someone is unless they told you. (Royce, 2026-10-13: tie it back to \"knowing the user ... we want to be that help\"; \"it doesn't need to be scripted. Cue should have a mind of its own but still be on brand\".)\n" : ""}- A closing question only when it's genuinely useful: a real choice between these that needs their say, or something their answer would change. Otherwise the captions and links are the whole message and "closing" is null. Never a generic check ("Does this one interest you?", "Thoughts?", "Any of these catch your eye?"). (Royce, 2026-11-11.)
- A caption is at most ${BUNDLE_LIMITS.captionChars - 40} characters and ${BUNDLE_LIMITS.captionSentences} sentences, and never ends with a question; the opening at most ${BUNDLE_LIMITS.openingChars}; the closing at most ${BUNDLE_LIMITS.closingChars}. Don't mention links.
- Keep three things apart: what its page says (said as the page's: "the page describes…"), your read of what that could do for them, and what isn't known. When something essential to the fit isn't in its facts, narrow what you say, or skip it.
- Never "apply now", "worth applying now" or any push to sign up unless its facts show a way to apply or register that was read and a state or deadline that makes now matter. Logistics they need to decide (day and time, area, cost, approval or registration state) when its facts give them; never a street address, never a guess.
- If two things have similar names, tell them apart by what they are, when and where.
- A suggestion for how to use it only when its format makes it useful (a small discussion where they'll be asked what they're building); most of the time what it is, why it's worth their time, and the link are the whole thing.
- ${IDENTITY_RULE} ${AUDIENCE_RULE} ${OFFER_HONESTY}
- A thing they didn't ask for is something you noticed for them: never say or imply they asked for it.
- Only the facts listed for a thing back what you say about it. Days, dates, prices, counts: only as written there.
- If one of them doesn't actually fit them, skip it (say why) rather than stretch, unless it's marked the best of its kind this morning: that one goes, captioned from its own facts. The member rules further down are never a reason to skip; fit is.
- A closing, when there is one, never offers to do something ("want me to...", "should I..."): what they want next is theirs to say.

THE THINGS (CONFIRMED_FACTS for each: the only facts you may state about it)
${items}
${i.set && many ? `\nTHE DAY'S SET (what Cue's pick saw in these together)\n${i.set}\n` : ""}${i.leadWhy ? `\nWHY THE FIRST ONE LEADS\n${i.leadWhy}\n` : ""}${i.memberBlock ? `\n${i.memberBlock}\n` : ""}${i.feeling ? `\nHOW THEY'VE BEEN FEELING (it shapes how you say this, never whether: if they've been struggling, gentler and lower-pressure; the captions never name it; your own line after the last thing may speak to what they're going through, gently, only from what's here; the closing question never names it)\n${i.feeling}\n` : ""}
THE THREAD (your recent texts with them, oldest first, their time)
${i.thread.trim() || "(nothing recent)"}
${i.threadLive && i.mayWait !== false ? `\nThey wrote to you within the last ${LIVE_MINUTES} minutes: a conversation may be live. Never land these on top of something unrelated. If the thread is about something else and not finished, answer with {"wait": "why"}. If it's about this, or it's clearly done, go ahead and say in "connects" how this follows from it.\n` : ""}${i.threadLive && i.mayWait === false ? `\nThey wrote to you within the last ${LIVE_MINUTES} minutes, and this can't wait any longer. If the thread is about something else, acknowledge it lightly in a few words in your first caption, and say in "connects" how you did.\n` : ""}${o.problems?.length ? `\nYOUR LAST VERSION (not sent)\n${o.last ?? ""}\nIt broke: ${o.problems.join(" | ")}. Write the whole message again with those fixed, keeping what worked.\n` : ""}
Answer only with JSON:
{${many ? '"opening": "the tie-back line", ' : '"opening": null, '}"items": [{"n": 1, "caption": "..."}, {"n": 2, "skip": "why it doesn't fit"}], "closing": "...?" or null${i.threadLive ? ', "connects": "how this follows from the thread"' : ""}}
or {"wait": "why"}`;
}

// ---------------------------------------------------------------- reading and checking (pure)

export type Draft = { wait?: string; opening: string | null; items: { n: number; caption?: string; skip?: string }[]; closing: string | null; connects: string | null };
export function readComposed(raw: string): Draft | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: any;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (typeof j?.wait === "string" && j.wait.trim()) return { wait: j.wait.trim(), opening: null, items: [], closing: null, connects: null };
  if (!Array.isArray(j?.items)) return null;
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);
  return {
    opening: str(j.opening),
    items: j.items.map((x: any) => ({ n: Number(x?.n), ...(str(x?.caption) ? { caption: str(x.caption)! } : {}), ...(str(x?.skip) ? { skip: str(x.skip)! } : {}) })),
    closing: str(j.closing),
    connects: str(j.connects),
  };
}

const tidy = (s: string) => capitalizeSentences(brandSafe(cleanCoMessage(s.trim().replace(/^["']|["']$/g, "").trim())));
const STOP = new Set("the and for but not you are was has had with that this what your have just like would want into some more they them their from about also then than over will its it's one there here where when been being who our out all any can get got".split(" "));
// When and what it costs are said in every caption by design: never evidence of a repeated reason (review of #135: two Saturday-evening
// free events read as the same reason).
const LOGISTICS = new Set("monday tuesday wednesday thursday friday saturday sunday weekend weeknight tonight tomorrow today morning afternoon evening night late early january february march april june july august september october november december sept free entry ticket tickets price dollars cost costs open doors starts start begins runs until noon week weeks next this".split(" "));
const meaning = (s: string, minus: Set<string>) => new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w) && !LOGISTICS.has(w) && !minus.has(w)));
// Pure: two captions giving the same reason: most of the smaller one's meaning words (beyond each thing's own name) are in the other.
export function sameReason(a: string, b: string, namesA: string, namesB: string): boolean {
  const minus = new Set([...(namesA.toLowerCase().match(/[a-z]{4,}/g) ?? []), ...(namesB.toLowerCase().match(/[a-z]{4,}/g) ?? [])]);
  const A = meaning(a, minus), B = meaning(b, minus);
  const small = Math.min(A.size, B.size);
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return small >= 3 && shared >= 3 && shared / small >= 0.6;
}
const STOCK = new Set([...OFFER_FOLLOWUP_MANY, ...OFFER_FOLLOWUP_ONE].map((s) => s.toLowerCase()));

// A caption saying the thing is a list (a roundup shared as one).
export const SAYS_LIST = /\b(?:list|lists|listing|roundup|round-up|rundown|write-?up|guide|post|several|a few|three|four|five|covers)\b/i;
// A push to apply or sign up now.
export const URGENT_APPLY = /\b(?:apply|register|sign(?:ing)? up|rsvp|request (?:a spot|to join)|grab (?:a|your) spot)\b[^.?!]{0,30}\b(?:now|today|asap|soon|early|while (?:it'?s|you can|there'?s))\b|\bworth (?:applying|registering|signing up)\b|\b(?:apply|register) (?:now|today|asap)\b/i;
// Their goal given back as the reason ("you're hunting an engineer", "that's the fit:").
export const GOAL_RESTATED = /\byou(?:'re| are) (?:hunting|looking|searching|on the hunt|trying to find)\b|\bthat'?s the fit\b/i;
// Going said as settled ("since you're going", "see you there"): a find offered is never a plan of theirs (#445: registered, planned and
// went are different).
export const PRESUMED_GOING = /\b(?:since|now that|as) you(?:'re| are) (?:going|attending|in|registered|signed up)\b|\bsee you there\b|\bwhen you go\b|\byou(?:'re| are) (?:already )?(?:going|registered|confirmed|on the list) (?:to|for)\b/i;
// A closing that only checks interest.
export const GENERIC_CLOSING = /^(?:so,?\s*)?(?:does|do|would|could|will)\s+(?:this|that|it|these|either|any(?: of (?:these|them|those))?|one of these)(?:\s+one)?\s+(?:interest|appeal to|sound (?:good|interesting|fun|like you)|work for|catch your eye|grab|speak to|land with)\b[^?]{0,20}\?$|^(?:interested|thoughts|any interest|worth a look|sound good)\?$/i;
const BENEFIT_VERB = /\b(?:meet|find|connect with|run into|cross paths with|hire|recruit|land|bump into)\b([^.;!?]{0,70})/gi;
const stem = (w: string) => w.replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, "");
// Pure: the words a caption says they could meet or find there that come from their own record and not the thing's. "the kind of room
// where you could meet an engineer" is caught when "engineer" is in what they told Cue and nowhere in the thing's own facts.
export function goalPasted(caption: string, record: string, theirs: string): string[] {
  if (!record.trim() || !theirs.trim()) return [];
  const words = (t: string) => new Set((t.toLowerCase().match(/[a-z]{4,}/g) ?? []).map(stem));
  const own = words(record), them = words(theirs);
  const out = new Set<string>();
  for (const m of caption.matchAll(BENEFIT_VERB)) {
    // A limit said plainly ("not a way to find an engineer") is the honest version, never a paste.
    const before = caption.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0).split(/[.;!?]/).pop() ?? "";
    if (NEGATED.test(before)) continue;
    const span = m[1].split(/,|\bnot\b|\bbut\b/i)[0];
    for (const w of span.toLowerCase().match(/[a-z]{4,}/g) ?? []) {
      const s = stem(w);
      if (!STOP.has(w) && !LOGISTICS.has(w) && !GENERIC_PEOPLE.has(s) && them.has(s) && !own.has(s)) out.add(w);
    }
  }
  return [...out];
}
const NEGATED = /\b(?:not|no|never|isn'?t|doesn'?t|don'?t|won'?t|can'?t|nor|rather than|instead of)\b/i;
// Words for people in general: never a goal pasted on ("someone solid", "people", "folks").
const GENERIC_PEOPLE = new Set("someone people folk person other others friend new good solid real just like-minded alongside meet find connect hire recruit land bump cross paths".split(" ").map(stem));

export type Checked = { captions: Map<number, string>; problems: { at: "opening" | "closing" | number | "bundle"; why: string }[] };
// Pure: every part of the draft against its rules. Caption numbers are 1-based, matching THE THINGS.
export function checkComposed(d: Draft, i: ComposeInput): Checked {
  const problems: Checked["problems"] = [];
  const captions = new Map<number, string>();
  const allFacts = Object.assign({}, ...i.items.map((b) => b.item.facts));
  i.items.forEach((b, idx) => {
    const n = idx + 1;
    const got = d.items.find((x) => x.n === n);
    if (!got || (!got.caption && !got.skip)) return problems.push({ at: n, why: `thing ${n} (${b.item.name}) has no caption` });
    if (got.skip) return;
    const c = tidy(got.caption!);
    const fails = checkDraft(c, { ...b.item.rules, maxChars: BUNDLE_LIMITS.captionChars, maxSentences: Math.max(b.item.rules.maxSentences ?? 0, BUNDLE_LIMITS.captionSentences) }).filter((k) => !k.pass);
    for (const f of fails) problems.push({ at: n, why: `thing ${n}'s caption: ${f.name}${f.reason ? ` (${f.reason})` : ""}` });
    if (stripClosingQuestion(c) !== c) problems.push({ at: n, why: `thing ${n}'s caption ends with a question; the closing asks` });
    if (/https?:\/\//i.test(c)) problems.push({ at: n, why: `thing ${n}'s caption has a link in it; the link goes on its own` });
    const unbacked = unbackedSpecifics(c, b.item.facts);
    if (unbacked.length) problems.push({ at: n, why: `thing ${n}'s caption says ${unbacked.map((u) => `"${u.text}"`).join(", ")}, which its facts don't back` });
    if ((stripUngroundedIdentity(c, b.item.grounding) ?? "").trim() !== c.trim()) problems.push({ at: n, why: `thing ${n}'s caption says who they are beyond what they've told Cue` });
    // A resend is never news (Royce, 2026-11-10): its caption and the reason it came back must agree. A rewrite, never a veto.
    if (b.again && NEW_CLAIM.test(c)) problems.push({ at: n, why: `thing ${n} was sent to them before; its caption calls it new or different from what was sent` });
    if (b.item.roundup && VERIFIED_CLAIM.test(c)) problems.push({ at: n, why: `thing ${n} is a post listing several places; its caption says something about a listed program's terms, availability or deadline that nobody checked` });
    // Royce, 2026-11-11: a roundup is said as one; no "apply now" without a checked way in; their goal is never put on the thing.
    if (b.item.roundup && !SAYS_LIST.test(c)) problems.push({ at: n, why: `thing ${n} is a post listing several things; its caption must say it's a list and what it covers, not describe it as one event` });
    if (URGENT_APPLY.test(c) && !b.item.applyRoute) problems.push({ at: n, why: `thing ${n}'s caption pushes them to apply or sign up now, and no way in with a state that makes now matter was read; say how it works from its facts, or leave that out` });
    const pasted = goalPasted(c, b.item.record ?? "", [i.memberBlock ?? "", b.item.grounding].join("\n"));
    if (pasted.length) problems.push({ at: n, why: `thing ${n}'s caption says they could meet or find ${pasted.map((w) => `"${w}"`).join(", ")} there, and its facts never mention that: say what its page supports (who it's for, what happens), and the limit` });
    if (PRESUMED_GOING.test(c)) problems.push({ at: n, why: `thing ${n}'s caption presumes they're going; nothing says they are (a request or a registration isn't going): say it as "if you go"` });
    if (GOAL_RESTATED.test(c)) problems.push({ at: n, why: `thing ${n}'s caption gives their goal back as the reason; say what the thing offers toward it, from its facts` });
    captions.set(n, c);
  });
  // The reason doesn't repeat (C1).
  const said = [...captions.entries()];
  for (let x = 0; x < said.length; x++)
    for (let y = x + 1; y < said.length; y++)
      if (sameReason(said[x][1], said[y][1], i.items[said[x][0] - 1].item.name, i.items[said[y][0] - 1].item.name)) problems.push({ at: "bundle", why: `captions ${said[x][0]} and ${said[y][0]} give the same reason; each caption says what's different about its own thing` });
  // The opening and the closing are held to every rule a caption is (review of #135: identity, "thinking about you" and "you asked"
  // went unchecked there): every item's forbidden patterns, and nothing about who they are beyond the grounding of the whole set.
  const forbidden = [...new Map(i.items.flatMap((b) => b.item.rules.forbidden ?? []).map((f) => [f.pattern.source, f])).values()];
  const grounding = i.items.map((b) => b.item.grounding).join("\n");
  // The closing line ties back to them: what they told Co (the member block, how they've been) grounds it too (review, 2026-10-13: a
  // true "new parent" tie-back was flagged because only the finds' facts counted).
  const aboutThem = [grounding, i.memberBlock ?? "", i.feeling ?? ""].join("\n");
  // Prices and counts in the opening or closing are held to the records of the whole set (Phase B4 over C).
  const backedBy = i.items.map((b) => b.item.rules.backedBy).filter((x): x is string => typeof x === "string" && !!x).join("\n") || undefined;
  const framing = (text: string, at: "opening" | "closing", maxChars: number) => {
    const bad = checkDraft(text, { maxChars, maxSentences: 2, forbidden, ...(backedBy ? { backedBy } : {}) }).filter((k) => !k.pass);
    if (bad.length) problems.push({ at, why: `the ${at}: ${bad.map((k) => `${k.name}${k.reason ? ` (${k.reason})` : ""}`).join(", ")}` });
    else if ((stripUngroundedIdentity(text, at === "opening" ? aboutThem : grounding) ?? "").trim() !== text.trim()) problems.push({ at, why: `the ${at} says who they are beyond what they've told Cue` });
    else if (unbackedSpecifics(text, allFacts).length) problems.push({ at, why: `the ${at} states something the things' facts don't back` });
    else return true;
    return false;
  };
  if (i.items.length > 1 && d.opening) {
    const o = tidy(d.opening);
    if (/\?\s*$/.test(o) || /https?:\/\//i.test(o)) problems.push({ at: "opening", why: "the opening is a question or has a link" });
    else framing(o, "opening", BUNDLE_LIMITS.openingChars);
  }
  if (d.closing) {
    const q = tidy(d.closing);
    if (!/\?\s*$/.test(q) || (q.match(/\?/g) ?? []).length > 1) problems.push({ at: "closing", why: "the closing must be one question" });
    else if (/\b(?:want me to|should i|shall i|i can (?:grab|save|book|hold|send|get)|let me (?:grab|save|book|hold))\b/i.test(q)) problems.push({ at: "closing", why: "the closing offers to do something; it asks which one, or whether any, interests them" });
    else if (q.length > BUNDLE_LIMITS.closingChars) problems.push({ at: "closing", why: `the closing is ${q.length} characters (max ${BUNDLE_LIMITS.closingChars})` });
    else if (STOCK.has(q.toLowerCase()) || GENERIC_CLOSING.test(q)) problems.push({ at: "closing", why: "the closing is a generic check; ask only when there's a real choice that needs their say, otherwise leave it out" });
    else if (!repeatQuestionCheck(q, i.recent).pass) problems.push({ at: "closing", why: "the closing repeats a question they already answered" });
    else framing(q, "closing", BUNDLE_LIMITS.closingChars);
  }
  // No closing is a complete message (Royce, 2026-11-11: a question only when it's genuinely useful).
  return { captions, problems };
}

// ---------------------------------------------------------------- the composer

// Pure: a bundle's things as the composer judges them (round-5 review of #441). A roundup is never a tier pick (it is judged for fit like any
// find, and may be skipped), and one post's link goes once per text: a second roundup item with the same link is dropped as covered.
export function roundupBundle(items: BundleItem[]): { items: BundleItem[]; dropped: Composed["dropped"] } {
  const seen = new Set<string>();
  const kept: BundleItem[] = [];
  const dropped: Composed["dropped"] = [];
  for (const b of items) {
    const it = b.item.roundup && b.tierPick ? { ...b, tierPick: false } : b;
    const link = it.item.roundup && it.item.url ? it.item.url : null;
    if (link && seen.has(link)) { dropped.push({ item: it, why: "the same post's link already goes in this text" }); continue; }
    if (link) seen.add(link);
    kept.push(it);
  }
  return { items: kept, dropped };
}

export async function composeBundle(input: ComposeInput, deps: ComposeDeps = realComposeDeps): Promise<ComposeResult> {
  const rb = roundupBundle(input.items);
  input = { ...input, items: rb.items };
  let items = [...input.items];
  const dropped: Composed["dropped"] = [...rb.dropped];
  const notes: string[] = [];
  let calls = 0;
  let problems: string[] = [];
  let last: string | null = null;
  const tierAsked = new Set<string>();
  while (calls < BUNDLE_LIMITS.calls) {
    const now: ComposeInput = { ...input, items };
    calls++;
    const raw: string = await deps.model(composePrompt(now, { problems, last })).catch(() => "");
    const d = readComposed(raw);
    if (!d) {
      problems = ["the answer wasn't the JSON asked for"];
      last = raw.slice(0, 800);
      continue;
    }
    if (d.wait) {
      // Waiting is for a live thread only, and only while it's still possible (facts, in code); otherwise write the message.
      if (input.threadLive && input.mayWait !== false) return { wait: d.wait, calls };
      problems = [input.threadLive ? "this can't wait any longer: write it, acknowledging the thread lightly first" : "they haven't written in a while: there's no live conversation to wait on; write the message"];
      last = raw.slice(0, 800);
      continue;
    }
    // A thing the composer skipped is taken out, and the rest composed again, so every caption is written for the set that goes.
    const skips = d.items.filter((x) => x.skip && x.n >= 1 && x.n <= items.length);
    // A morning tier pick is never skipped for fit (review of the tier PR): the first time, it's written again with that said; only a
    // second skip takes it out, and dispatch then queues its tier's next best.
    const tierSkips = skips.filter((x) => items[x.n - 1].tierPick && !tierAsked.has(items[x.n - 1].candidate.id));
    if (tierSkips.length) {
      for (const x of tierSkips) tierAsked.add(items[x.n - 1].candidate.id);
      problems = tierSkips.map((x) => `thing ${x.n} is the best of its kind for them this morning: it goes, never skipped for fit; caption it from its own facts`);
      last = raw.slice(0, 800);
      continue;
    }
    if (skips.length) {
      if (skips.some((x) => x.n === 1)) return { fail: `the first thing doesn't fit: ${skips.find((x) => x.n === 1)!.skip}`, leadSkipped: true, ...(items[0].tierPick ? { tierSkipped: true } : {}), calls, notes };
      for (const s of skips) dropped.push({ item: items[s.n - 1], why: `skipped by the composer: ${s.skip}`, ...(items[s.n - 1].tierPick ? { tierSkipped: true } : {}) });
      items = items.filter((_, idx) => !skips.some((s) => s.n === idx + 1));
      // The pick's view of the set was about the set it chose: once the set changes, it no longer describes what goes.
      input = { ...input, set: null };
      problems = [];
      last = null;
      continue;
    }
    if (input.threadLive && !d.connects) {
      problems = [`they wrote within the last ${LIVE_MINUTES} minutes: either wait, or say in "connects" how this follows from the thread`];
      last = raw.slice(0, 800);
      continue;
    }
    const checked = checkComposed(d, now);
    const blocking = checked.problems.filter((p) => p.at !== "opening" && p.at !== "closing");
    const finalCall = calls >= BUNDLE_LIMITS.calls;
    if (blocking.length || (!finalCall && checked.problems.length)) {
      if (!finalCall) {
        problems = checked.problems.map((p) => p.why);
        last = raw.slice(0, 1200);
        // After a redraft, a sibling whose caption still fails is taken out, and the rest composed once more (never sent half-fixed).
        if (problems.length && calls >= 2) {
          const badSiblings = [...new Set(blocking.filter((p) => typeof p.at === "number" && p.at > 1).map((p) => p.at as number))];
          if (badSiblings.length && !blocking.some((p) => p.at === 1 || p.at === "bundle")) {
            for (const n of badSiblings) dropped.push({ item: items[n - 1], why: blocking.filter((p) => p.at === n).map((p) => p.why).join("; ") });
            items = items.filter((_, idx) => !badSiblings.includes(idx + 1));
            input = { ...input, set: null };
            problems = [];
            last = null;
          }
        }
        continue;
      }
      return { fail: `the composed message didn't hold up: ${blocking.map((p) => p.why).join("; ")}`, calls, notes };
    }
    // The opening and the closing are Co's own or nothing: one that still doesn't hold up on the last try is left out (no stock line).
    const openingBad = checked.problems.some((p) => p.at === "opening");
    const closingBad = checked.problems.some((p) => p.at === "closing");
    if (openingBad) notes.push("opening left out: it didn't hold up");
    if (closingBad) notes.push("closing left out: it didn't hold up");
    // The tie-back line (kept as "opening"), sent after every find's link and description, when there's more than one (Royce, 2026-10-13:
    // each find on its own, link then description; the line that ties them back to their why goes at the end).
    const opening = items.length > 1 && d.opening && !openingBad ? tidy(d.opening) : null;
    const closing = d.closing && !closingBad ? tidy(d.closing) : null;
    const messages: string[] = [];
    items.forEach((b, idx) => {
      if (b.item.url) messages.push(b.item.url);
      messages.push(checked.captions.get(idx + 1)!);
    });
    if (opening) messages.push(opening);
    if (closing) messages.push(closing);
    const words = [...items.map((_, idx) => checked.captions.get(idx + 1)!), opening, closing].filter(Boolean) as string[];
    const perItem = items.map((b, idx) => ({ candidate: b.candidate, messages: [...(b.item.url ? [b.item.url] : []), checked.captions.get(idx + 1)!] }));
    return { messages, text: words.join("\n"), included: items, dropped, opening, closing, perItem, calls, notes };
  }
  return { fail: `the composer couldn't write it in ${BUNDLE_LIMITS.calls} tries${problems.length ? `: ${problems.join("; ")}` : ""}`, calls, notes };
}
