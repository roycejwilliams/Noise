// The whole exchange (Royce, 2026-11-03), golden: the real failures of the 11-03 baseline (notes/whole-exchange-baseline-1103.md),
// rebuilt with invented names, through the real read (the move, what "that" meant, what they answered, what they closed) and the real
// reply with the draft check. Each waits on its first recording (AWAITING_RECORDING): not recorded by the PR that added them.
//   npm run evals:golden:record -- --only <id>
import "../../lib/requireMeter.js";
import { AWAITING_RECORDING, result, type GoldenCase, type GoldenStatus } from "../types.js";
import { DAY, NONE, judge, observed, reply, type Line } from "./checkins.js";

const NEW: GoldenStatus = { live: true }; // recorded 2026-11-03 after #371 ($0.48)
const at = (min: number) => new Date(DAY.getTime() - min * 60_000);
const QUESTION = /\?\s*$/m;

export const CASES: GoldenCase[] = [
  {
    n: 67,
    id: "exchange-feedback-reask",
    title: "They already said how the meeting went: Cue builds on it, never asks how it went",
    status: NEW,
    from: "11-03 baseline: \"how'd the meeting go, felt aligned?\" sent 5h after they had said it went well",
    run: async () => {
      const exchange: Line[] = [
        { at: at(300), from: "co", text: "How'd the meeting with Theo go on Sunday?" },
        { at: at(295), from: "member", text: "Went well, we're aligned on the split. Feedback on the deck: too long, loved the opener." },
        { at: at(294), from: "co", text: "Good to hear." },
      ];
      const r = await reply({ firstName: "Sam", now: DAY, exchange, searching: NONE, message: "ok what's next", withExchange: {} });
      const misses: string[] = [];
      if (/how(?:'d| did) (?:the )?meeting|how did it go|what did you think of the deck|any feedback/i.test(r.text)) misses.push("asks again what they already told");
      const j = await judge(r.text, `Earlier they said the meeting with Theo went well and gave deck feedback ("too long, loved the opener"). Now: "ok what's next"`, "Does the reply build on what they already said (the split, the deck feedback) without asking how the meeting went or for the deck feedback again?");
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return result(misses, observed(r));
    },
  },
  {
    n: 68,
    id: "exchange-summary-after-correction",
    title: "\"No, the problem about Theo\" after a wrong summary: the summary of Theo, as the whole reply, no advice or question",
    status: NEW,
    from: "11-02/11-03: the problem-statement correction; the next reply still didn't do it",
    run: async () => {
      const exchange: Line[] = [
        { at: at(20), from: "member", text: "Give me my problem statement" },
        { at: at(19), from: "co", text: "The core tension: you need to prove the matching works without exposing how it's built." },
      ];
      const r = await reply({ firstName: "Sam", now: DAY, exchange, searching: NONE, message: "No I want the problem about Theo", withExchange: {}, withMoment: true });
      const misses: string[] = [];
      if (QUESTION.test(r.text)) misses.push("a question in a summary they asked for");
      if (!/Theo/.test(r.text)) misses.push("not about Theo");
      return result(misses, observed(r));
    },
  },
  {
    n: 69,
    id: "exchange-double-interested",
    title: "One find, one interest question: never \"either interest you?\" and \"does this one interest you?\" together",
    status: NEW,
    from: "11-03 baseline: 4 double interest questions on active members",
    run: async () => {
      const r = await reply({ firstName: "Ari", now: DAY, exchange: [], searching: NONE, message: "anything for wednesday night? something low key", withExchange: { sent: [{ name: "Harbor Jazz Night", url: "https://example.test/harbor-jazz" }] } });
      const n = (r.text.match(/interest(?:s|ed)? you|worth a look|want me to/gi) ?? []).length;
      return result(n > 1 ? [`asks interest ${n} times`] : [], observed(r));
    },
  },
  {
    n: 70,
    id: "exchange-thanks-close",
    title: "\"perfect, thanks\": acknowledged once, no new question, find or offer",
    status: NEW,
    from: "11-03 baseline: \"perfect, talk then\" got the email question; \"great job\" got a find and a question",
    run: async () => {
      const exchange: Line[] = [
        { at: at(6), from: "member", text: "can you send the address for thursday?" },
        { at: at(5), from: "co", text: "It's 412 Pier Street, doors at 8." },
      ];
      const r = await reply({ firstName: "Ari", now: DAY, exchange, searching: NONE, message: "perfect, thanks", withExchange: {} });
      const misses: string[] = [];
      if (QUESTION.test(r.text)) misses.push("a question after they closed");
      if (/https?:\/\//.test(r.text)) misses.push("a link after they closed");
      return result(misses, observed(r));
    },
  },
  {
    n: 71,
    id: "exchange-got-the-venue",
    title: "\"got the venue!\": congratulations, the venue ask closes, and no more venue finds or questions",
    status: NEW,
    from: "11-03 baseline: venue and DJ finds days after the ask was dropped or solved (13 reopenings, 8 active members)",
    run: async () => {
      const exchange: Line[] = [
        { at: at(1440), from: "co", text: "https://example.test/nightbird-room" },
        { at: at(1440), from: "co", text: "The Nightingale Room seats twelve in Hayes Valley. Want more like it?" },
      ];
      const r = await reply({ firstName: "Noor", now: DAY, exchange, searching: { asks: ["a private dining room for twelve near Hayes Valley"], goals: [], held: [] }, message: "got the venue! booked the back room at Fern", withExchange: { asks: ["a private dining room for twelve near Hayes Valley"], sent: [{ name: "The Nightingale Room", url: "https://example.test/nightbird-room" }] } });
      const misses: string[] = [];
      if (/https?:\/\//.test(r.text)) misses.push("a link after they got the venue");
      if (/\b(?:another|more) (?:option|room|venue|spot)|want me to keep/i.test(r.text)) misses.push("keeps the venue search going");
      return result(misses, observed(r));
    },
  },
  {
    n: 72,
    id: "exchange-that-referent",
    title: "\"what time does that start?\" after two finds, the jazz night last discussed: answers about the jazz night",
    status: NEW,
    from: "11-03: 'losing what \"that\" refers to' (Royce); the referent misses in the baseline's correction turns",
    run: async () => {
      const exchange: Line[] = [
        { at: at(30), from: "co", text: "https://example.test/mission-book-fair" },
        { at: at(30), from: "co", text: "Mission Book Fair, Saturday 10am, free." },
        { at: at(12), from: "co", text: "https://example.test/harbor-jazz" },
        { at: at(12), from: "co", text: "Harbor Jazz Night, Thursday 8pm at the pier." },
        { at: at(8), from: "member", text: "ooh the jazz one sounds good" },
        { at: at(7), from: "co", text: "It's a small room, mostly locals." },
      ];
      const r = await reply({ firstName: "Ari", now: DAY, exchange, searching: NONE, message: "what time does that start?", withExchange: { sent: [{ name: "Harbor Jazz Night", url: "https://example.test/harbor-jazz" }, { name: "Mission Book Fair", url: "https://example.test/mission-book-fair" }] } });
      const misses: string[] = [];
      if (!/8/.test(r.text)) misses.push("doesn't give the jazz night's start");
      if (/10\s?am|book fair/i.test(r.text)) misses.push("answers about the book fair");
      return result(misses, observed(r));
    },
  },
];
