// "Which one and why", golden (Royce, 2026-11-11): from a real turn, rebuilt with an invented member and the three events Cue had sent as
// facts, on the replay harness's pinned day. "What do you think is the best option for me this week?" got a bare pick, and "What's the
// details and why it fits?" got a "not confirmed" line with an unrelated follow-up promise, then the details anyway. The bar: one
// reasoned pick with a short comparison against the options already sent, the details, the uncertainty, the benefit type with its
// limits and the link, together, with no contradiction, no unrelated promise and no presumed attendance. Each waits on its first
// recording (AWAITING_RECORDING): not recorded by the PR that added them.
//   npm run evals:golden:record -- --only best-option-pick,best-option-why-it-fits
import "../../lib/requireMeter.js";
import { AWAITING_RECORDING, result, type GoldenCase, type GoldenStatus } from "../types.js";
import { DAY, NONE, judge, observed, reply, type Line, type Reply } from "./checkins.js";
// Everything the member received this turn, in order: a link sent on its own (shareLink) is in the sends, not in the reply text (audit
// 2026-11-11: the pick's link went first, as DECISION_LINE asks, and these cases read only the reply text, so "no link" was the test's).
const delivered = (r: Reply) => (r.sends.length ? r.sends.map((s) => s.text).join("\n") : r.text);

const NEW: GoldenStatus = { live: false, until: AWAITING_RECORDING, why: "added with the cut-redraft and decision-question fix; needs its first recording" };
const at = (min: number) => new Date(DAY.getTime() - min * 60_000);
const SENT = [
  { name: "Speech & NLP Paper Reading Meetup", url: "https://lu.ma/speech-nlp-papers-test" },
  { name: "SGLang x NVIDIA Meetup", url: "https://lu.ma/sglang-nvidia-test" },
  { name: "Founder Dinner SF", url: "https://lu.ma/founder-dinner-sf-test" },
];
// The sent finds' stored facts, as the reply's facts carry them (services/turnContext.ts sentDetailLines), invented wording.
const FACTS: [string, string][] = [
  ["known", `Cue sent them "Speech & NLP Paper Reading Meetup" (${SENT[0].url}) on Mon Oct 12: Thu Oct 15, 6:00-8:00pm, San Francisco. From its page: pizza, then 45 minutes of discussing one paper; no pitching.`],
  ["known", `Cue sent them "SGLang x NVIDIA Meetup" (${SENT[1].url}) on Mon Oct 12: Tue Oct 13 (today), 5:30-8:30pm, San Francisco, free. From its page (read Mon Oct 12): hosted by NVIDIA, SGLang and Modal; drinks and talks with engineers working on inference and tooling. No exact venue listed when it was read.`],
  ["known", `Cue sent them "Founder Dinner SF" (${SENT[2].url}) on Mon Oct 12: Wed Oct 14, 7:00pm, San Francisco. From its page: a seated dinner for early-stage founders, 12 seats.`],
  ["known", `They told Cue they're looking for a founding engineer for their voice startup.`],
];
const exchange: Line[] = [
  { at: at(1500), from: "co", text: SENT[0].url },
  { at: at(1500), from: "co", text: "A paper reading, pizza and one paper, no pitching." },
  { at: at(1499), from: "co", text: SENT[1].url },
  { at: at(1499), from: "co", text: "SGLang and NVIDIA's meetup, engineers working on inference." },
  { at: at(1498), from: "co", text: SENT[2].url },
  { at: at(1498), from: "co", text: "A small founder dinner Wednesday." },
];
const PROMISE = /\b(?:i'?ll (?:follow up|check in|text you|reach out)|follow up with you)\b/i;
const PRESUMES = /\bhow (?:both|it|they|the \w+(?: \w+)?) went\b|\bhow was\b/i;
const NOT_CONFIRMED = /\b(?:don'?t have|not) (?:the )?details? confirmed\b|\bwon'?t guess\b/i;

export const CASES: GoldenCase[] = [
  {
    n: 84,
    id: "best-option-pick",
    title: "\"Best option for me this week?\" after three finds: one pick, why it beats the other two, details, what's unknown, its link",
    status: NEW,
    from: "Royce, 2026-11-11: \"Tonight's SGLang x NVIDIA meetup is probably it.\" went alone, the comparison cut by the fact check",
    turns: 1,
    run: async () => {
      const r = await reply({ firstName: "Sam", now: DAY, exchange, searching: NONE, message: "What do you think is the best option for me this week?", facts: FACTS as any, withExchange: { sent: SENT } });
      const misses: string[] = [];
      const t = delivered(r);
      const picked = SENT.filter((s) => t.includes(s.url));
      if (!/SGLang|paper reading|Paper Reading|Founder Dinner|founder dinner/i.test(t)) misses.push("names no pick");
      const others = [/paper/i, /SGLang|NVIDIA|inference/i, /founder dinner|dinner/i].filter((re) => re.test(t)).length;
      if (others < 2) misses.push("no comparison with the other options already sent");
      if (!picked.length) misses.push("no link for the pick");
      if (PROMISE.test(t)) misses.push("an unrelated promise");
      if (PRESUMES.test(t)) misses.push("presumes attendance");
      const j = await judge(t, "Cue had sent three events (a paper reading, an SGLang x NVIDIA inference meetup tonight, a small founder dinner). The member, who wants a founding engineer, asked which is the best option this week.", "Does the reply make one clear pick, say briefly why it beats each of the other two, give the details that decide it and what's unknown, and say which kind of benefit it offers (meeting someone to build with, learning from practitioners, or both) without claiming who will be there?");
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return result(misses, observed(r));
    },
  },
  {
    n: 85,
    id: "best-option-why-it-fits",
    title: "\"What's the details and why it fits?\": details, benefit type with its limit and the link together; no 'not confirmed', no unrelated promise",
    status: NEW,
    from: "Royce, 2026-11-11: \"Don't have the details confirmed yet... I'll follow up Wed morning on how both... went\", then the details in a second text",
    turns: 1,
    run: async () => {
      const ex: Line[] = [...exchange, { at: at(3), from: "member", text: "What do you think is the best option for me this week?" }, { at: at(2), from: "co", text: "Tonight's SGLang x NVIDIA meetup is probably it." }];
      const r = await reply({ firstName: "Sam", now: DAY, exchange: ex, searching: NONE, message: "What’s the details and why it fits?", facts: FACTS as any, withExchange: { sent: SENT } });
      const misses: string[] = [];
      const t = delivered(r);
      if (!/5:30/.test(t)) misses.push("no time");
      if (!t.includes(SENT[1].url)) misses.push("no link");
      if (NOT_CONFIRMED.test(t)) misses.push("says the details aren't confirmed while giving them (contradiction)");
      if (PROMISE.test(t)) misses.push("an unrelated promise");
      if (PRESUMES.test(t)) misses.push("presumes attendance");
      const j = await judge(t, "The member asked for the details of tonight's SGLang x NVIDIA meetup (hosted by NVIDIA, SGLang and Modal; drinks and talks with engineers working on inference and tooling; no venue listed) and why it fits them (they want a founding engineer).", "Does the reply give the details and name which kind of benefit the event offers from its own facts (learning from people working on inference, a chance to meet an engineer to build with, or both, labelled), with its limit (who comes isn't known), rather than only restating the member's own goal?");
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return result(misses, observed(r));
    },
  },
];
