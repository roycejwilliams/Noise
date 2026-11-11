// "Best option" answered from the reads made at send (Royce, 2026-11-11): the 06:05 turn rebuilt with an invented member, the three events
// Cue had sent each carrying its match.read (services/opportunityRead.ts), rendered into the reply's facts the way the text route does
// (services/turnContext.ts sentFindFacts). The probe: the comparison and the details come from the reads, and the fact check passes the
// page-stated audience, hosts and format instead of cutting them as claims about other people. Waits on its first recording.
//   npm run evals:golden:record -- --only best-option-from-reads
import "../../lib/requireMeter.js";
import { AWAITING_RECORDING, result, type GoldenCase, type GoldenStatus } from "../types.js";
import { DAY, NONE, judge, observed, reply, type Line } from "./checkins.js";

const NEW: GoldenStatus = { live: false, until: AWAITING_RECORDING, why: "added with the read-backed reply facts and the claim-type fix; needs its first recording" };
const at = (min: number) => new Date(DAY.getTime() - min * 60_000);
const readAt = new Date(DAY.getTime() - 26 * 3_600_000).toISOString();
const ev = (name: string, url: string, read: any) => ({ key: `event:${url}`, name, kind: "event" as const, url, sentAt: new Date(readAt), reaction: null, details: null, postText: null, opportunityRead: { v: 1, url, source: "event_record", readAt, ...read } });
const SENT = [
  ev("Speech & NLP Paper Reading Meetup", "https://lu.ma/speech-nlp-papers-test", { facts: [{ field: "when", text: "starts 2026-10-15T18:00, ends 2026-10-15T20:00", quote: null }, { field: "format", text: "pizza, then 45 minutes discussing one paper", quote: "45 minutes of paper discussion" }, { field: "requirements", text: "no pitching", quote: "no pitching" }], unknowns: ["who comes beyond people reading the paper"], benefits: [{ kind: "learn_from_practitioners", because: "pizza, then 45 minutes discussing one paper" }] }),
  ev("SGLang x NVIDIA Meetup", "https://lu.ma/sglang-nvidia-test", { facts: [{ field: "when", text: "starts 2026-10-13T17:30, ends 2026-10-13T20:30", quote: null }, { field: "cost", text: "free", quote: null }, { field: "host", text: "hosted by NVIDIA, SGLang, Modal", quote: null }, { field: "audience", text: "engineers working on inference and tooling", quote: "engineers working on inference and tooling" }, { field: "format", text: "drinks and talks", quote: "drinks and talks" }], unknowns: ["the exact venue"], benefits: [{ kind: "learn_from_practitioners", because: "engineers working on inference and tooling" }] }),
  ev("Founder Dinner SF", "https://lu.ma/founder-dinner-sf-test", { facts: [{ field: "when", text: "starts 2026-10-14T19:00", quote: null }, { field: "format", text: "a seated dinner", quote: "seated dinner" }, { field: "audience", text: "early-stage founders", quote: "early-stage founders" }, { field: "size", text: "12 seats", quote: "12 seats" }], unknowns: ["how guests are picked"], benefits: [{ kind: "peer_founders", because: "early-stage founders" }] }),
];
const exchange: Line[] = SENT.flatMap((s, i) => [{ at: at(1500 - i), from: "co" as const, text: s.url }, { at: at(1500 - i), from: "co" as const, text: s.name }]);
const CUT_A_READ_FACT = /other_person:[^|]*(?:engineers|inference|NVIDIA|SGLang|Modal|founders)/i;

export const CASES: GoldenCase[] = [
  {
    n: 75,
    id: "best-option-from-reads",
    title: "\"Best option this week?\" with reads on the three sent finds: the comparison and details come from the reads and survive the fact check",
    status: NEW,
    from: "Royce, 2026-11-11: the 06:05 comparison was cut as other_person; answer from the same record the send used",
    turns: 1,
    run: async () => {
      const T = await import("../../../src/services/turnContext.js");
      const facts = SENT.flatMap((s) => T.sentFindFacts(s as any, DAY, "America/Los_Angeles")).map((t) => ["known", t]) as any;
      facts.push(["known", "They told Cue they're looking for a founding engineer for their voice startup."]);
      const r = await reply({ firstName: "Sam", now: DAY, exchange, searching: NONE, message: "What do you think is the best option for me this week?", facts, withExchange: { sent: SENT.map((s) => ({ name: s.name, url: s.url })) } });
      const misses: string[] = [];
      if (r.checked.some((c) => CUT_A_READ_FACT.test(c))) misses.push(`the fact check cut a read's page-stated fact as other_person: ${r.checked.join(" || ").slice(0, 300)}`);
      if ([/paper/i, /SGLang|NVIDIA|inference/i, /dinner/i].filter((re) => re.test(r.text)).length < 2) misses.push("no comparison with the other options already sent");
      if (!SENT.some((s) => r.text.includes(s.url))) misses.push("no link for the pick");
      const j = await judge(r.text, "Cue had sent three events, each with its page read: a paper reading (pizza, 45 minutes on one paper, no pitching), an SGLang x NVIDIA meetup tonight (hosted by NVIDIA, SGLang, Modal; for engineers working on inference and tooling; drinks and talks; venue unknown), and a seated dinner for early-stage founders. The member wants a founding engineer.", "Does the reply make one pick, compare it to the other two using those facts, name the benefit kind the facts support (learning from practitioners vs peer founders) with its limit, and avoid claiming who will be there?");
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return result(misses, observed(r));
    },
  },
];
