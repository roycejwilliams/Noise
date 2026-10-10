// One composer per proactive bundle (Royce, 2026-10-10, Phase C). A bundle of finds used to be stitched by one line of code from
// blind parts: each caption drafted alone (told "Co is reaching out first", "one message, one reason", even the second and third),
// then a closing question written from the names only, with stock lines as its fallback. No part saw the others, the thread, or why
// Co's pick chose them, so the same reason could repeat three times and a find could land on top of a live conversation.
//
// Now one model call, given the member record, the thread, every find with its facts and the pick's own why, and the pick's view of
// the day's set, writes the whole message as one thought: an opening line when there's more than one thing (why these, together),
// each find's caption, and the closing question that comes out of what it just said (C1-C3, C5). Quality control is inside (C4): code
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
import { AUDIENCE_RULE, OFFER_HONESTY, REVEAL_MAX_CHARS } from "../agent/eventDiscoverySurfacing.js";
import { checkDraft, DRAFT_MODEL, renderFacts, type Candidate } from "./proactive.js";

export const BUNDLE_LIMITS = { openingChars: 180, closingChars: 140, captionChars: REVEAL_MAX_CHARS, calls: 3 } as const;

// The pick's own reading of one find (services/sweepSelect.ts): why it's for this member, and why now. Null for a find that didn't come
// through the pick.
export type PickWhy = { whyMember: string; whyNow: string } | null;
export type BundleItem = { candidate: Candidate; item: RevealItem; pick: PickWhy; again: boolean };
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
};
export type ComposeDeps = { model: (prompt: string) => Promise<string> };
export const realComposeDeps: ComposeDeps = {
  model: async (prompt) => (await generateText({ model: anthropic(DRAFT_MODEL), experimental_telemetry: { isEnabled: true, functionId: "proactive.bundleComposer" }, prompt })).text,
};
export const LIVE_MINUTES = 45;

export type Composed = {
  messages: string[];
  // The words Co wrote, joined (for payload first, the ledger and the log).
  text: string;
  included: BundleItem[];
  dropped: { item: BundleItem; why: string }[];
  opening: string | null;
  closing: string | null;
  // Each included thing's own messages (its link and its caption), in order, for the send ledger.
  perItem: { candidate: Candidate; messages: string[] }[];
  calls: number;
  notes: string[];
};
export type ComposeResult = Composed | { wait: string; calls: number } | { fail: string; leadSkipped?: boolean; calls: number; notes: string[] };

// ---------------------------------------------------------------- the prompt (pure)

export function composePrompt(i: ComposeInput, o: { problems?: string[]; last?: string | null } = {}): string {
  const many = i.items.length > 1;
  const items = i.items
    .map((b, n) => {
      const pick = b.pick ? `\nwhy Co's daily pick chose it for them: ${b.pick.whyMember}${b.pick.whyNow ? `\nwhy now: ${b.pick.whyNow}` : ""}` : "";
      return `THING ${n + 1}${n === 0 ? " (it leads)" : ""}${b.item.url ? " (its link goes out as its own message right before your caption)" : ""}${b.item.shortNotice ? " (short notice: say so plainly, no pressure)" : ""}${b.again ? " (you mentioned it over a month ago with no reply; it's still open: circle back once, lightly)" : ""}\n${renderFacts(b.item.facts)}${pick}`;
    })
    .join("\n\n");
  return `${CO_VOICE}

${CO_TEXT_CHANNEL} You're texting ${i.firstName}. Co is reaching out first with ${many ? `${i.items.length} things, together, as one thought` : "one thing"}.

HOW IT GOES OUT
${many ? "- An opening line: one short sentence on why these, together, today (the day's set below says what Co's pick saw). No greeting formula, no list, nothing any text could open with.\n" : "- No opening line: it's one thing.\n"}- Then, for each thing in order: its link (sent for you, as its own message) and your caption under it. Each caption names the thing and when it is, and says the one reason it fits them, in plain words. ${CO_WHY}
- Every caption knows the others: never give the same reason twice. If they share a reason, say it once${many ? ", in the opening" : ""}, and let each caption say what's different about its own.
- Then one closing question that comes out of what you just said${many ? " about this set (which one, or whether any of them)" : ""}. Short, natural, yours: never a stock line.
- A caption is at most ${BUNDLE_LIMITS.captionChars - 40} characters and never ends with a question; the opening at most ${BUNDLE_LIMITS.openingChars}; the closing at most ${BUNDLE_LIMITS.closingChars}. Don't mention links.
- ${IDENTITY_RULE} ${AUDIENCE_RULE} ${OFFER_HONESTY}
- A thing they didn't ask for is something you noticed for them: never say or imply they asked for it.
- Only the facts listed for a thing back what you say about it. Days, dates, prices, counts: only as written there.
- If one of them doesn't actually fit, skip it (say why) rather than stretch.

THE THINGS
${items}
${i.set ? `\nTHE DAY'S SET (what Co's pick saw in these together)\n${i.set}\n` : ""}${i.leadWhy ? `\nWHY THE FIRST ONE LEADS\n${i.leadWhy}\n` : ""}${i.memberBlock ? `\n${i.memberBlock}\n` : ""}${i.feeling ? `\nHOW THEY'VE BEEN FEELING (it shapes how you say this, never whether: if they've been struggling, gentler and lower-pressure; never name the feeling)\n${i.feeling}\n` : ""}
THE THREAD (your recent texts with them, oldest first, their time)
${i.thread.trim() || "(nothing recent)"}
${i.threadLive ? `\nThey wrote to you within the last ${LIVE_MINUTES} minutes: a conversation may be live. Never land these on top of something unrelated. If the thread is about something else and not finished, answer with {"wait": "why"}. If it's about this, or it's clearly done, go ahead and say in "connects" how this follows from it.\n` : ""}${o.problems?.length ? `\nYOUR LAST VERSION (not sent)\n${o.last ?? ""}\nIt broke: ${o.problems.join(" | ")}. Write the whole message again with those fixed, keeping what worked.\n` : ""}
Answer only with JSON:
{${many ? '"opening": "...", ' : '"opening": null, '}"items": [{"n": 1, "caption": "..."}, {"n": 2, "skip": "why it doesn't fit"}], "closing": "...?"${i.threadLive ? ', "connects": "how this follows from the thread"' : ""}}
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
const meaning = (s: string, minus: Set<string>) => new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w) && !minus.has(w)));
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
    const fails = checkDraft(c, { ...b.item.rules, maxChars: Math.min(b.item.rules.maxChars ?? BUNDLE_LIMITS.captionChars, BUNDLE_LIMITS.captionChars) }).filter((k) => !k.pass);
    for (const f of fails) problems.push({ at: n, why: `thing ${n}'s caption: ${f.name}${f.reason ? ` (${f.reason})` : ""}` });
    if (stripClosingQuestion(c) !== c) problems.push({ at: n, why: `thing ${n}'s caption ends with a question; the closing asks` });
    if (/https?:\/\//i.test(c)) problems.push({ at: n, why: `thing ${n}'s caption has a link in it; the link goes on its own` });
    const unbacked = unbackedSpecifics(c, b.item.facts);
    if (unbacked.length) problems.push({ at: n, why: `thing ${n}'s caption says ${unbacked.map((u) => `"${u.text}"`).join(", ")}, which its facts don't back` });
    if ((stripUngroundedIdentity(c, b.item.grounding) ?? "").trim() !== c.trim()) problems.push({ at: n, why: `thing ${n}'s caption says who they are beyond what they've told Co` });
    captions.set(n, c);
  });
  // The reason doesn't repeat (C1).
  const said = [...captions.entries()];
  for (let x = 0; x < said.length; x++)
    for (let y = x + 1; y < said.length; y++)
      if (sameReason(said[x][1], said[y][1], i.items[said[x][0] - 1].item.name, i.items[said[y][0] - 1].item.name)) problems.push({ at: "bundle", why: `captions ${said[x][0]} and ${said[y][0]} give the same reason; say a shared reason once${i.items.length > 1 ? " in the opening" : ""} and what's different in each` });
  if (i.items.length > 1 && d.opening) {
    const o = tidy(d.opening);
    const bad = checkDraft(o, { maxChars: BUNDLE_LIMITS.openingChars, maxSentences: 2 }).filter((k) => !k.pass);
    if (bad.length || /\?\s*$/.test(o) || /https?:\/\//i.test(o)) problems.push({ at: "opening", why: `the opening: ${bad.map((k) => k.name).join(", ") || "it's a question or has a link"}` });
    else if (unbackedSpecifics(o, allFacts).length) problems.push({ at: "opening", why: "the opening states something the things' facts don't back" });
  }
  if (d.closing) {
    const q = tidy(d.closing);
    if (!/\?\s*$/.test(q) || (q.match(/\?/g) ?? []).length > 1) problems.push({ at: "closing", why: "the closing must be one question" });
    else if (q.length > BUNDLE_LIMITS.closingChars) problems.push({ at: "closing", why: `the closing is ${q.length} characters (max ${BUNDLE_LIMITS.closingChars})` });
    else if (STOCK.has(q.toLowerCase())) problems.push({ at: "closing", why: "the closing is a stock line; write it from what you said" });
    else if (!repeatQuestionCheck(q, i.recent).pass) problems.push({ at: "closing", why: "the closing repeats a question they already answered" });
    else if (unbackedSpecifics(q, allFacts).length) problems.push({ at: "closing", why: "the closing states something the facts don't back" });
  } else problems.push({ at: "closing", why: "no closing question" });
  return { captions, problems };
}

// ---------------------------------------------------------------- the composer

export async function composeBundle(input: ComposeInput, deps: ComposeDeps = realComposeDeps): Promise<ComposeResult> {
  let items = [...input.items];
  const dropped: Composed["dropped"] = [];
  const notes: string[] = [];
  let calls = 0;
  let problems: string[] = [];
  let last: string | null = null;
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
      // Waiting is for a live thread only (a fact, in code): with none, it's a draft that didn't do the job.
      if (input.threadLive) return { wait: d.wait, calls };
      problems = ["they haven't written in a while: there's no live conversation to wait on; write the message"];
      last = raw.slice(0, 800);
      continue;
    }
    // A thing the composer skipped is taken out, and the rest composed again, so every caption is written for the set that goes.
    const skips = d.items.filter((x) => x.skip && x.n >= 1 && x.n <= items.length);
    if (skips.length) {
      if (skips.some((x) => x.n === 1)) return { fail: `the first thing doesn't fit: ${skips.find((x) => x.n === 1)!.skip}`, leadSkipped: true, calls, notes };
      for (const s of skips) dropped.push({ item: items[s.n - 1], why: `skipped by the composer: ${s.skip}` });
      items = items.filter((_, idx) => !skips.some((s) => s.n === idx + 1));
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
    const opening = items.length > 1 && d.opening && !openingBad ? tidy(d.opening) : null;
    const closing = d.closing && !closingBad ? tidy(d.closing) : null;
    const messages: string[] = [];
    if (opening) messages.push(opening);
    items.forEach((b, idx) => {
      if (b.item.url) messages.push(b.item.url);
      messages.push(checked.captions.get(idx + 1)!);
    });
    if (closing) messages.push(closing);
    const words = [opening, ...items.map((_, idx) => checked.captions.get(idx + 1)!), closing].filter(Boolean) as string[];
    const perItem = items.map((b, idx) => ({ candidate: b.candidate, messages: [...(b.item.url ? [b.item.url] : []), checked.captions.get(idx + 1)!] }));
    return { messages, text: words.join("\n"), included: items, dropped, opening, closing, perItem, calls, notes };
  }
  return { fail: `the composer couldn't write it in ${BUNDLE_LIMITS.calls} tries${problems.length ? `: ${problems.join("; ")}` : ""}`, calls, notes };
}
