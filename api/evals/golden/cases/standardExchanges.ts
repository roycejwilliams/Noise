// The standard exchanges (Royce, 2026-11-11: "one fixed set of about 10 realistic exchanges, recorded once, as the standard"). Each is
// a real failure from the 11-09 to 11-11 thread, rebuilt with invented members, events and links: the history Cue already sent (the
// finds, its captions, the member's earlier lines) is seeded, then the member's next message (or two) runs through the real reply turn
// (cases/checkins.ts reply(): the turn read, the reply agent and its tools, the fact check; no database, nothing sent).
//
// The pass condition is the WHOLE exchange from the member's side: reading the thread, they can tell what it is, how it helps them, its
// limits and the next step without having to interrogate Cue. Code checks the clear failures each case was written against (the hard
// rules, evals/lib/hardRules.ts, run on every reply anyway); one judge question reads the whole exchange for the rest.
//
// All eleven wait on their first recording (AWAITING_RECORDING). They are meant to be recorded AFTER the two in-flight product PRs
// (recommendation depth / the event record, and reply-path coherence) land, so the recording is of the fixed behavior:
//   npm run evals:golden:record -- --only std-
import "../../lib/requireMeter.js";
import { AWAITING_RECORDING, result, type GoldenCase, type GoldenStatus } from "../types.js";
import { DAY, NONE, judge, reply, type Kind, type Line, type Reply } from "./checkins.js";
import type { StubEvent } from "../../../src/agent/loopTools.js";
import { ASSUMES_WENT, EVENT_UNCONFIRMED, TIPS_LATER, inventedClaim } from "../standardMatchers.js";

const PENDING: GoldenStatus = {
  live: false,
  until: `${AWAITING_RECORDING}, after the recommendation-depth and reply-coherence PRs land`,
  why: "the standard set (2026-11-11): written before the fixes it measures, recorded once they are in",
};
const at = (iso: string) => new Date(iso);
const later = (d: Date, sec: number) => new Date(d.getTime() + sec * 1000);
const URL_RE = /https?:\/\/[^\s"'<>)]+/g;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
// Everything the member received this turn, in order (the reply, each link, each find), and the links among it.
const delivered = (r: Reply) => (r.sends.length ? r.sends.map((s) => s.text).join("\n") : r.text);
const linksIn = (r: Reply) => [...new Set((delivered(r).match(URL_RE) ?? []).map((u) => u.replace(/[.,!?;:]+$/, "")))];
const shows = (r: Reply) => `${r.sends.length ? r.sends.map((s) => `[${s.kind}] ${s.text}`).join(" / ") : r.text}${r.tools.length ? `  [tools ${r.tools.join(",")}]` : ""}${r.checked.length ? `  [fact check ${r.checked.join(" || ")}]` : ""}`;
const done = (misses: string[], rs: Reply[]) => result(misses, rs.map(shows).join("  ||  "));
// The thread as the member reads it, for the whole-exchange judge.
const transcript = (lines: Line[], turns: { message: string; r: Reply }[]) =>
  [...lines.map((l) => `${l.from === "member" ? "Member" : "Cue"}: ${l.text}`), ...turns.flatMap((t) => [`Member: ${t.message}`, `Cue: ${delivered(t.r)}`])].join("\n");
const WHOLE = "Reading the whole exchange from the member's side, can they understand what it is, how it helps them, its limits and the next step without having to interrogate Cue?";
// Slips no reply of any kind makes (beyond the hard rules): no reply at all, a list, the old name.
function slips(r: Reply, turn = ""): string[] {
  const m: string[] = [];
  const t = delivered(r);
  if ((!t.trim() && !r.reacted) || /^ERROR /.test(r.text)) m.push(`${turn}no reply (${r.text.slice(0, 80)})`);
  if (/\bCo\b|\bMo\b/.test(t)) m.push(`${turn}calls itself Co (or names Mo)`);
  return m;
}

// ---- Jordan: a two-person dev-tools founder hiring a founding engineer; three events already sent (cases 73, 74, 78).
const JORDAN_FACTS: [Kind, string][] = [
  ["known", "Co-founder of a two-person developer-tools startup (AI inference tooling); looking for a founding engineer; has said pitch-heavy events wear them out."],
];
const READING = { name: "Gradient Reading Club", url: "https://example.test/gradient-reading-club" };
const INFERENCE = { name: "Inference Engineers Meetup", url: "https://example.test/inference-engineers" };
const FOUNDRY = { name: "Foundry Founder Dinner", url: "https://example.test/foundry-founder-dinner" };
const THREE = [READING, INFERENCE, FOUNDRY];
const SENT_AT = at("2026-10-12T23:30:00Z"); // Mon Oct 12, 4:30pm Pacific
const THREE_SENT: Line[] = [
  { at: SENT_AT, from: "co", text: READING.url },
  { at: later(SENT_AT, 1), from: "co", text: "Gradient Reading Club, Thursday 7pm in SoMa: one paper, read together, no pitching." },
  { at: later(SENT_AT, 2), from: "co", text: INFERENCE.url },
  { at: later(SENT_AT, 3), from: "co", text: "Inference Engineers Meetup, tonight 6:30pm in the Mission: talks on serving models in production." },
  { at: later(SENT_AT, 4), from: "co", text: FOUNDRY.url },
  { at: later(SENT_AT, 5), from: "co", text: "Foundry Founder Dinner, Friday 7:30pm: twelve seed-stage founders at one table." },
];
const THREE_FACTS: [Kind, string][] = [
  ["did_before", `Cue sent them "${READING.name}" (${READING.url}), "${INFERENCE.name}" (${INFERENCE.url}) and "${FOUNDRY.name}" (${FOUNDRY.url}) on Mon Oct 12 at 4:30pm, each as its link and a one-line caption. They haven't reacted to any of them.`],
  ["known", `Details on file for "${READING.name}": Thursday Oct 15, 7pm, a members' loft in SoMa; about 30 people, mostly ML researchers and engineers; one paper is read and discussed together; the page says "no pitching, no recruiting talk"; free, RSVP on the page. Not on file: which paper.`],
  ["known", `Details on file for "${INFERENCE.name}": Tuesday Oct 13, 6:30pm, a brewery hall in the Mission; three 15-minute talks on serving models in production, then open networking; about 120 RSVPs; free. Not on file: the speakers' names, who else attends.`],
  ["known", `Details on file for "${FOUNDRY.name}": Friday Oct 16, 7:30pm, hosted by an early-stage fund; twelve seed-stage founders at one table; $40 a seat; apply on the page, the host picks the table. Not on file: who the other founders are.`],
];
const JORDAN = { firstName: "Jordan", now: DAY, searching: { asks: [], goals: ["a founding engineer for their developer-tools startup"], held: [] }, withExchange: { sent: THREE } };
// "you're hunting an engineer": their goal handed back to them as if it were news (the 11-10 reply).
const GOAL_ECHO = /\b(?:since |because |as )?you(?:'re| are)\s+(?:hunting|looking|searching|trying to (?:find|hire)|out to (?:find|hire)|hiring)\b[^.?\n]{0,30}\bengineer/i;

// ---- Noor: a casual ask, and the wine bar Cue sent on Saturday (cases 79, 80).
const VELLUM = { name: "Vellum Wine Room", url: "https://example.test/vellum-wine-room" };
const VELLUM_STUB: StubEvent = { name: VELLUM.name, url: VELLUM.url, tier: 2, lines: ["A small natural-wine bar on Hayes Street in Hayes Valley, open until 11pm tonight.", "Walk-ins only, about twenty seats, by-the-glass list that changes weekly."] };

// ---- The founder dinner pages (cases 75, 76): a roundup blog post, and a thin page with the deciding facts missing.
const ROUNDUP: StubEvent = { name: "Founder Dinner (from \"11 SF founder events this fall\")", url: "https://example.test/blog/sf-founder-events-fall", tier: 2, lines: ["This page is a blog roundup listing eleven San Francisco founder events this fall, not the dinner's own page.", "One entry: a founder dinner on Thursday Oct 22, hosted by a seed fund, \"details to come\".", "The roundup links no application or RSVP page for the dinner."] };
const SUPPER: StubEvent = { name: "Founders Supper", url: "https://example.test/founders-supper", tier: 2, lines: ["Wednesday Oct 21, 7pm, SoMa.", "The page says only: \"15-20 founders, dinner and conversation.\"", "Nothing on the page about the format, who the founders are, their stage, whether anyone is hiring, or the cost."] };
const APPLY_NOW = /\b(?:apply (?:now|here|today|soon|before)|applications? (?:are |is )?open|grab (?:a|your) (?:seat|spot)|(?:rsvp|sign up|register) (?:now|here|today))\b/i;

export const CASES: GoldenCase[] = [
  {
    n: 73,
    id: "std-best-option-this-week",
    title: "\"What's the best option for me this week?\" after three finds: one pick, why it beats the other two from the facts, and its link",
    status: PENDING,
    from: "11-09 thread: three events sent (paper reading, inference meetup tonight, founder dinner); the answer was a bare headline",
    run: async () => {
      const message = "What's the best option for me this week?";
      const r = await reply({ ...JORDAN, exchange: THREE_SENT, facts: [...JORDAN_FACTS, ...THREE_FACTS], message });
      const misses = slips(r);
      const t = delivered(r).replace(URL_RE, " ");
      if (words(t) < 15) misses.push(`a bare headline (${words(t)} words): no reason it beats the others`);
      const links = linksIn(r);
      if (!links.some((u) => THREE.some((e) => e.url === u))) misses.push("the pick goes without its link");
      if (links.filter((u) => THREE.some((e) => e.url === u)).length > 1) misses.push("sends more than one of the three links: no single pick");
      const j = await judge(delivered(r), `Thread:\n${transcript(THREE_SENT, [{ message, r }])}\nOn file: ${THREE_FACTS.slice(1).map((f) => f[1]).join(" ")} The member is a founder hiring a founding engineer; pitch-heavy events wear them out.`, `Does Cue make ONE pick, say why it beats the other two using only the details on file (not generic praise, nothing invented), and include that pick's link? ${WHOLE} Answer yes only if all of that holds.`);
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, [r]);
    },
  },
  {
    n: 74,
    id: "std-details-and-fit",
    title: "\"What's the details and why it fits?\" after a bare pick: details, the kind of benefit named, the limits, in one coherent answer",
    status: PENDING,
    from: "11-10 thread: \"not confirmed\" followed by the details anyway, an unrelated follow-up promise, and the goal pasted back (\"you're hunting an engineer\")",
    run: async () => {
      const exchange: Line[] = [
        ...THREE_SENT,
        { at: at("2026-10-13T20:40:00Z"), from: "member", text: "What's the best option for me this week?" },
        { at: at("2026-10-13T20:40:30Z"), from: "co", text: "The Inference Engineers Meetup tonight." },
      ];
      const message = "What's the details and why it fits?";
      const r = await reply({ ...JORDAN, exchange, facts: [...JORDAN_FACTS, ...THREE_FACTS], message });
      const misses = slips(r);
      const t = delivered(r);
      if (EVENT_UNCONFIRMED.test(t)) misses.push(`calls the event not confirmed, then gives the details on file anyway ("${t.match(EVENT_UNCONFIRMED)![0]}")`);
      if (/\bI(?:'ll| will) (?:keep an eye|keep looking|look out|let you know|circle back|follow up|check back|send (?:you )?more|dig)/i.test(t)) misses.push("a follow-up promise in place of the answer");
      if (GOAL_ECHO.test(t)) misses.push(`pastes their goal back ("${t.match(GOAL_ECHO)![0]}")`);
      if (!/6:30|tonight|Mission|brewery|talks?|120/i.test(t)) misses.push("no details from what's on file");
      const j = await judge(t, `Thread:\n${transcript(exchange, [{ message, r }])}\nOn file: ${THREE_FACTS[2][1]} The member is a founder hiring a founding engineer.`, `Is it one coherent answer that gives the details on file, NAMES the kind of benefit (for example: meeting a potential hire or collaborator, versus learning from practitioners) rather than a vague "good fit", and says its limits (what isn't known, like who attends, or what the format makes hard), without inventing anything, promising unrelated follow-up, or restating their goal back to them? ${WHOLE} Answer yes only if all of that holds.`);
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, [r]);
    },
  },
  {
    n: 75,
    id: "std-roundup-page",
    title: "A founder dinner found only on a roundup blog post: labeled as a roundup (or held), never \"apply now\" with no application route",
    status: PENDING,
    from: "11-10 thread: a blog listing several events went out as the founder dinner itself, with \"apply now\"",
    run: async () => {
      const message = "Any founder dinners coming up in the next couple of weeks? Something small.";
      const r = await reply({ firstName: "Jordan", now: DAY, exchange: [], searching: NONE, facts: JORDAN_FACTS, message, stubEvents: [ROUNDUP] });
      const misses = slips(r);
      const t = delivered(r);
      const sent = linksIn(r).includes(ROUNDUP.url);
      if (APPLY_NOW.test(t)) misses.push(`"${t.match(APPLY_NOW)![0]}" with no application route on file`);
      if (sent && !/\b(?:roundup|round-up|list(?:ing|s|ed)?|blog|post|article|eleven)\b/i.test(t)) misses.push("sends the roundup as if it were the dinner's own page");
      const j = await judge(t, `The member asked: "${message}". Cue's search found only a blog roundup (${ROUNDUP.url}) listing eleven SF founder events, one entry a founder dinner on Thu Oct 22 hosted by a seed fund, "details to come", with no application or RSVP link.`, `Does Cue either hold it (say nothing solid turned up, or offer to look for the dinner's own page) or share it clearly labeled as a roundup that mentions the dinner, WITHOUT presenting the post as the dinner's page, telling them to apply or RSVP, or inventing details about the dinner? ${WHOLE} Answer yes only if all of that holds.`);
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, [r]);
    },
  },
  {
    n: 76,
    id: "std-thin-page",
    title: "A thin page (\"15-20 founders\", nothing on format or audience) for an engineer hunt: a narrowed claim or no recommendation, no invented benefit",
    status: PENDING,
    from: "11-10 thread: a page with one line on size went out with a benefit nothing on it supported",
    run: async () => {
      const message = "Is there a founder dinner this month that would actually help me find a founding engineer?";
      const r = await reply({ firstName: "Jordan", now: DAY, exchange: [], searching: { asks: [], goals: ["a founding engineer for their developer-tools startup"], held: [] }, facts: JORDAN_FACTS, message, stubEvents: [SUPPER] });
      const misses = slips(r);
      const t = delivered(r);
      const claim = inventedClaim(t);
      if (claim) misses.push(`claims what the page doesn't say ("${claim}")`);
      const j = await judge(t, `The member asked: "${message}". Cue's search found one page: "${SUPPER.name}" (${SUPPER.url}), Wed Oct 21, 7pm, SoMa; it says only "15-20 founders, dinner and conversation"; nothing about format, who the founders are, their stage, whether anyone is hiring, or cost.`, `Does Cue either make a narrowed claim (what the page does say, and plainly that the deciding thing for an engineer hunt, who is in the room, isn't on it) or decline to recommend it, WITHOUT inventing a benefit (engineers attending, intimacy, curation, hiring talk) or overselling it as a fit? ${WHOLE} Answer yes only if all of that holds.`);
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, [r]);
    },
  },
  {
    n: 77,
    id: "std-matching-scenario",
    title: "A teammate asks how matching works, then for a scenario: a full walkthrough labeled as a hypothetical, no deflection",
    status: PENDING,
    turns: 2,
    from: "11-11 thread: \"tell me more about your matching system... give me a scenario\" was deflected",
    run: async () => {
      const base = { firstName: "Ellis", now: DAY, searching: NONE, facts: [["known", "Works on the Noise team (partnerships); talks to event hosts about how Cue introduces people. Asks about Cue to explain it to others."]] as [Kind, string][] };
      const opener: Line[] = [
        { at: at("2026-10-13T20:30:00Z"), from: "member", text: "Got a host call tomorrow and they'll ask how this works" },
        { at: at("2026-10-13T20:30:30Z"), from: "co", text: "Happy to walk it through with you first." },
      ];
      const m1 = "Tell me more about your matching system";
      const r1 = await reply({ ...base, exchange: opener, message: m1 });
      const thread2: Line[] = [...opener, { at: at("2026-10-13T20:45:00Z"), from: "member", text: m1 }, { at: at("2026-10-13T20:45:30Z"), from: "co", text: delivered(r1) }];
      const m2 = "Ok give me a scenario. Walk me through one start to finish";
      const r2 = await reply({ ...base, exchange: thread2, message: m2 });
      const misses = [...slips(r1, "turn 1: "), ...slips(r2, "turn 2: ")];
      const DEFLECT = /\b(?:can(?:'t|not)|won't|not able to) (?:share|get into|go into|walk (?:you )?through|explain)|\b(?:that's|it's) (?:internal|proprietary|confidential)|\bbest (?:to )?(?:ask|check with)\b/i;
      for (const [i, r] of [r1, r2].entries()) if (DEFLECT.test(delivered(r))) misses.push(`turn ${i + 1} deflects ("${delivered(r).match(DEFLECT)![0]}")`);
      if (!/\b(?:say|imagine|picture|suppose|hypothetical|for example|example|let's say)\b/i.test(delivered(r2))) misses.push("turn 2: the scenario isn't labeled as a hypothetical");
      const j = await judge(delivered(r2), `A teammate on the Noise team, preparing for a host call, asked Cue "${m1}" then "${m2}".\nThread:\n${transcript(thread2, [{ message: m2, r: r2 }])}`, `Is Cue's last text a full scenario, clearly labeled as a hypothetical, that walks start to finish through how a connection happens (what Cue learns about each person, why it would put two people together, how both say yes before anyone is introduced, and what happens after), WITHOUT deflecting, staying abstract, or naming real members? ${WHOLE} Answer yes only if all of that holds.`);
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, [r1, r2]);
    },
  },
  {
    n: 78,
    id: "std-pushback-repeat",
    title: "\"You said the same thing twice\": a different angle on the pick, not the same reason reworded",
    status: PENDING,
    from: "11-10 thread: the pushback drew a third rewording of the same reason",
    run: async () => {
      const SAME_1 = "The dinner puts you at one table with twelve seed founders, so you'd hear who else is hiring engineers.";
      const SAME_2 = "Twelve founders at one table means you'll hear who's hiring engineers right now.";
      const exchange: Line[] = [
        ...THREE_SENT,
        { at: at("2026-10-13T20:20:00Z"), from: "member", text: "Why the Foundry dinner over the reading club?" },
        { at: at("2026-10-13T20:20:30Z"), from: "co", text: SAME_1 },
        { at: at("2026-10-13T20:22:00Z"), from: "member", text: "Hm ok but why is that good for me" },
        { at: at("2026-10-13T20:22:30Z"), from: "co", text: SAME_2 },
      ];
      const message = "You said the same thing twice";
      const r = await reply({ ...JORDAN, exchange, facts: [...JORDAN_FACTS, ...THREE_FACTS], message, kind: "feedback" });
      const misses = slips(r);
      // Whether it's the same reason reworded is the judge's call: "twelve founders, but nothing says any are hiring engineers" is a new angle.
      const j = await judge(delivered(r), `Thread:\n${transcript(exchange, [{ message, r }])}\nOn file: ${THREE_FACTS.slice(1).map((f) => f[1]).join(" ")} The member is a founder hiring a founding engineer; pitch-heavy events wear them out.`, `After the member pointed out the repeat, does Cue own it in a few words at most and then give a genuinely DIFFERENT angle (a new reason from the details on file, an honest limit of the dinner, or reconsidering the pick, for example the reading club's room of ML engineers), not the same twelve-founders-who's-hiring point reworded, and without explaining how it works? ${WHOLE} Answer yes only if all of that holds.`);
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, [r]);
    },
  },
  {
    n: 79,
    id: "std-quick-wine-spot",
    title: "A casual \"low key wine spot tonight?\": the link first, then one line; no four-text restatement",
    status: PENDING,
    from: "11-09 thread: a quick wine ask got four texts restating the same bar",
    run: async () => {
      const exchange: Line[] = [
        { at: at("2026-10-13T20:10:00Z"), from: "member", text: "long day, meeting a friend after work" },
        { at: at("2026-10-13T20:10:30Z"), from: "co", text: "Sounds like you've earned it." },
      ];
      const message = "know a low key wine spot near Hayes Valley for tonight?";
      const r = await reply({ firstName: "Noor", now: DAY, exchange, searching: NONE, message, stubEvents: [VELLUM_STUB] });
      const misses = slips(r);
      const texts = r.sends.filter((s) => s.text.trim());
      const link = texts.findIndex((s) => s.text.includes(VELLUM.url));
      if (link < 0) misses.push("no link to the spot");
      else {
        if (texts.slice(0, link).some((s) => /vellum/i.test(s.text))) misses.push("talks about the spot before its link");
        if (texts.length - link - 1 > 1) misses.push(`${texts.length - link - 1} texts after the link: more than its one line`);
      }
      if (texts.length > 2) misses.push(`${texts.length} texts for a casual ask`);
      return done(misses, [r]);
    },
  },
  {
    n: 80,
    id: "std-resend-past-find",
    title: "\"send me that wine bar again\": the link it sent before, resent",
    status: PENDING,
    from: "11-10 thread: a re-asked past find got a description, not the link",
    run: async () => {
      const sentAt = at("2026-10-10T23:00:00Z"); // Sat Oct 10, 4pm Pacific
      const exchange: Line[] = [
        { at: sentAt, from: "member", text: "somewhere for a glass of wine near Hayes Valley tonight?" },
        { at: later(sentAt, 30), from: "co", text: VELLUM.url },
        { at: later(sentAt, 31), from: "co", text: "Vellum Wine Room on Hayes Street: natural wine, walk-ins only, open till 11." },
        { at: later(sentAt, 120), from: "member", text: "perfect" },
      ];
      const message = "send me that wine bar again?";
      const r = await reply({ firstName: "Noor", now: DAY, exchange, searching: NONE, facts: [["did_before", `Cue sent them "${VELLUM.name}" (${VELLUM.url}) on Sat Oct 10 at 4pm, with: "Vellum Wine Room on Hayes Street: natural wine, walk-ins only, open till 11."`]], message, withExchange: { sent: [VELLUM] } });
      const misses = slips(r);
      if (!linksIn(r).includes(VELLUM.url)) misses.push("the link isn't resent");
      if (linksIn(r).some((u) => u !== VELLUM.url)) misses.push("sends a different link");
      if (r.sends.filter((s) => s.text.trim()).length > 2) misses.push("more than the link and one line");
      return done(misses, [r]);
    },
  },
  {
    n: 81,
    id: "std-unconfirmed-attendance",
    title: "An event sent, never answered, now past: Cue never asks \"how was it\"; at most \"did you end up going\"",
    status: PENDING,
    from: "11-10 thread: \"how was it?\" about an event the member never said they'd go to (standing rule, 11-04: never assume attendance)",
    run: async () => {
      const MAKERS = { name: "Mission Makers Night", url: "https://example.test/mission-makers-night" };
      const sentAt = at("2026-10-10T18:00:00Z"); // Sat Oct 10, 11am Pacific
      const exchange: Line[] = [
        { at: sentAt, from: "co", text: MAKERS.url },
        { at: later(sentAt, 1), from: "co", text: "Mission Makers Night, Monday 7pm: hardware and design folks showing what they're building." },
      ];
      const message = "Finally surfacing. Monday was a lot";
      const r = await reply({ firstName: "Ari", now: DAY, exchange, searching: NONE, sent: [{ name: MAKERS.name, sentAt, endsOn: "2026-10-12" }], facts: [["did_before", `Cue sent them "${MAKERS.name}" (${MAKERS.url}) on Sat Oct 10 at 11am, with: "Mission Makers Night, Monday 7pm: hardware and design folks showing what they're building." They never replied to it or said whether they'd go. It was Mon Oct 12 at 7pm.`]], message, withExchange: { sent: [MAKERS] } });
      const misses = slips(r);
      const t = delivered(r);
      if (ASSUMES_WENT.test(t)) misses.push(`assumes they went ("${t.match(ASSUMES_WENT)![0]}")`);
      const j = await judge(t, `Cue sent the member an event (Mission Makers Night, Mon Oct 12 at 7pm) on Saturday; they never replied or said they'd go. Now, Tuesday: "${message}".`, `Does Cue meet what they said WITHOUT assuming they went to the event (no "how was it", no "glad you made it", no asking what they thought of it)? Mentioning the event at most as a neutral "did you end up going" is fine, and not mentioning it is fine. ${WHOLE} Answer yes only if all of that holds.`);
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, [r]);
    },
  },
  {
    n: 82,
    id: "std-vent-plus-ask",
    title: "\"drained after the demo... any tips for first meetings with engineers?\": received, then concrete help, all delivered this turn",
    status: PENDING,
    from: "11-11 thread: the vent got sympathy and the ask got a promise of tips later",
    run: async () => {
      const exchange: Line[] = [
        { at: at("2026-10-13T16:00:00Z"), from: "member", text: "Demo day for the angels at 1. Wish me luck" },
        { at: at("2026-10-13T16:00:30Z"), from: "co", text: "You know the product cold. Lead with the latency numbers." },
      ];
      const message = "Drained after the demo, it went fine but I'm empty. Any tips for first meetings with engineers? I've got two coffees with candidates Thursday";
      const r = await reply({ firstName: "Sam", now: DAY, exchange, searching: NONE, facts: [["known", "Solo founder of an AI developer-tools startup; hiring a founding engineer; demoed to angel investors today at 1pm."]], message, withMoment: true });
      const misses = slips(r);
      const t = delivered(r);
      if (TIPS_LATER.test(t)) misses.push("promises the tips later instead of giving them");
      if (words(t) < 30) misses.push(`${words(t)} words: no room for concrete help`);
      const j = await judge(t, `Earlier: Cue wished them luck on a demo for angels at 1pm. Now: "${message}".`, `Does Cue first receive how they feel in a line (specific to the demo and being empty, not a stock phrase, no therapy question), and then give concrete, usable advice for a first coffee with an engineering candidate (things to ask, show or say), all in this turn, not promised for later? ${WHOLE} Answer yes only if all of that holds.`);
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, [r]);
    },
  },
  {
    n: 83,
    id: "std-old-rec-not-new",
    title: "A residency already discussed and set aside comes back in the search: never resent as new; the new find goes",
    status: PENDING,
    from: "11-11 thread: a residency the member had already talked through was sent again as a fresh find",
    run: async () => {
      const RESIDENCY: StubEvent = { name: "Northgate Founder Residency", url: "https://example.test/northgate-residency", tier: 2, lines: ["A 10-week residency in SF for pre-seed founders; applications close Nov 20."] };
      const BUILDERS: StubEvent = { name: "Applied ML Builders Night", url: "https://example.test/applied-ml-builders", tier: 2, lines: ["Thursday Oct 15, 6pm in SoMa: engineers demo what they've shipped with small models; about 60 people; free."] };
      const sentAt = at("2026-10-09T17:00:00Z"); // Fri Oct 9, 10am Pacific
      const exchange: Line[] = [
        { at: sentAt, from: "co", text: RESIDENCY.url },
        { at: later(sentAt, 1), from: "co", text: "Northgate Founder Residency: 10 weeks in SF for pre-seed founders, applications close Nov 20." },
        { at: later(sentAt, 600), from: "member", text: "Looked at it. Not for me right now, I can't do 10 weeks in person. Maybe spring" },
        { at: later(sentAt, 630), from: "co", text: "Makes sense. It runs again in spring." },
      ];
      const message = "Anything new worth my time this week?";
      const r = await reply({ firstName: "Jordan", now: DAY, exchange, searching: NONE, facts: [...JORDAN_FACTS, ["did_before", `Cue sent them "${RESIDENCY.name}" (${RESIDENCY.url}) on Fri Oct 9; they said "Not for me right now, I can't do 10 weeks in person. Maybe spring".`]], message, stubEvents: [RESIDENCY, BUILDERS], withExchange: { sent: [{ name: RESIDENCY.name, url: RESIDENCY.url }] } });
      const misses = slips(r);
      const t = delivered(r);
      if (linksIn(r).includes(RESIDENCY.url)) misses.push("resends the residency's link");
      if (/northgate|residency/i.test(t) && !/\b(?:spring|already|earlier|last week|before|again)\b/i.test(t)) misses.push("brings the residency up as if it were new");
      const j = await judge(t, `On Fri Oct 9 Cue sent the Northgate Founder Residency; the member said "Not for me right now, I can't do 10 weeks in person. Maybe spring". Today they asked "${message}" and Cue's search returned the residency again plus a new event, Applied ML Builders Night (Thu Oct 15, 6pm, SoMa, engineers demoing what they've shipped with small models).`, `Does Cue leave the residency out (or at most mention it as the one they already set aside for spring), never presenting it as new, and share what is actually new? ${WHOLE} Answer yes only if all of that holds.`);
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, [r]);
    },
  },
];
