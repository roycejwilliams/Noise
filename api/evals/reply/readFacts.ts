// A question about finds Cue already sent is answered from each find's read made at send (match.read, services/opportunityRead.ts;
// Royce, 2026-11-11), and the fact check treats that read's page-stated audience, hosts and format as details its FACT backs, not as
// claims about other people. From the 11-11 06:05 turn, the three events Cue had sent, with invented reads. Zero tokens: whether the live
// claim read now passes "it's for engineers working on inference" is model judgment, which layer 1 can't prove (the golden case
// best-option-from-reads, awaiting its first recording, is the paid check).
//   npx tsx evals/reply/readFacts.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import { readFileSync } from "node:fs";
const T = await import("../../src/services/turnContext.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};

const readAt = "2026-11-10T18:00:00.000Z";
const READS = {
  papers: { v: 1, url: "https://lu.ma/speech-nlp-papers", source: "event_record", readAt, facts: [{ field: "format", text: "pizza, then 45 minutes discussing one paper", quote: "45 minutes of paper discussion" }, { field: "requirements", text: "no pitching", quote: "no pitching" }], unknowns: ["who comes beyond people reading the paper"], benefits: [{ kind: "learn_from_practitioners", because: "pizza, then 45 minutes discussing one paper" }] },
  sglang: { v: 1, url: "https://lu.ma/sglang-nvidia", source: "event_record", readAt, facts: [{ field: "when", text: "starts 2026-11-11T17:30, ends 2026-11-11T20:30", quote: null }, { field: "host", text: "hosted by NVIDIA, SGLang, Modal", quote: null }, { field: "audience", text: "engineers working on inference and tooling", quote: "engineers working on inference and tooling" }, { field: "format", text: "drinks and talks", quote: "drinks and talks" }], unknowns: ["the exact venue"], benefits: [{ kind: "learn_from_practitioners", because: "engineers working on inference and tooling" }] },
  dinner: { v: 1, url: "https://lu.ma/founder-dinner", source: "event_record", readAt, facts: [{ field: "format", text: "a seated dinner", quote: "seated dinner" }, { field: "audience", text: "early-stage founders", quote: "early-stage founders" }], unknowns: ["how guests are picked"], benefits: [{ kind: "peer_founders", because: "early-stage founders" }] },
} as const;
const item = (name: string, url: string, read: unknown) => ({ key: `event:${url}`, name, kind: "event" as const, url, sentAt: new Date("2026-11-10T18:00:00Z"), reaction: null, details: null, postText: null, opportunityRead: T.readOnFile(read) });
const SENT = [item("Speech & NLP Paper Reading Meetup", "https://lu.ma/speech-nlp-papers", READS.papers), item("SGLang x NVIDIA Meetup", "https://lu.ma/sglang-nvidia", READS.sglang), item("Founder Dinner", "https://lu.ma/founder-dinner", READS.dinner)];
const now = new Date("2026-11-11T14:05:00Z");

// ---------------------------------------------------------------- the reads are the find facts the reply and the fact check see
const lines = SENT.map((s) => T.sentFindFacts(s, now, "America/Los_Angeles").join("\n"));
check("each sent find's facts carry its read: who it's for, format, hosts, as the page states them", /audience: "engineers working on inference and tooling"/.test(lines[1]) && /host: hosted by NVIDIA, SGLang, Modal/.test(lines[1]) && /format: "drinks and talks"/.test(lines[1]) && /format: "seated dinner"/.test(lines[2]) && /45 minutes/.test(lines[0]), lines);
check("... what the page doesn't say stays an unknown", /Not stated, so unknown[^\n]*the exact venue/.test(lines[1]) && /how guests are picked/.test(lines[2]), lines);
check("... and only the benefits its facts support, by kind (learning vs peer founders)", /learning from people doing the work/.test(lines[1]) && /time with other founders at a similar stage/.test(lines[2]) && !/meeting people who might build or work with them/.test(lines.join("\n")), lines);
check("... said as of when it was read", lines.every((l) => /as read Nov 10/.test(l)), lines);
check("a find with a read no longer says its page hasn't been read", !lines.some((l) => /hasn't been read yet/.test(l)), lines);
check("a find without a read is unchanged", T.sentFindFacts({ ...SENT[0], opportunityRead: null }, now).some((l) => /hasn't been read yet/.test(l)));
// Review of #458: only the page's quoted words go into a FACT; Cue's paraphrase never rides in to back a claim.
check("a quoted fact goes in as its quote, never with Cue's paraphrase beside it", !lines.some((l) => /Cue's read:/.test(l)) && !/pizza, then 45 minutes discussing one paper/.test(lines[0]) && /format: "45 minutes of paper discussion"/.test(lines[0]) && !/format: a seated dinner/.test(lines[2]), lines);
check("... and a benefit's reason is the quote it rests on", /because "?45 minutes of paper discussion/.test(lines[0]) || /because 45 minutes of paper discussion/.test(lines[0]), lines[0]);
// Review of #458: a read on file still says what it lacks.
check("a read with no start or area still says it has no start time or street address", /Cue has no start time or street address on file for "Speech & NLP Paper Reading Meetup"/.test(lines[0]) && /Cue has no street address on file for "SGLang x NVIDIA Meetup"/.test(lines[1]), lines);
check("... and a find with a city and a read without an area keeps 'its street address isn't stored'", T.sentFindFacts({ ...SENT[2], city: "San Francisco" }, now).some((l) => /is in San Francisco; its street address isn't stored/.test(l)));
check("the claim read never takes Cue's paraphrase as support", /Words in a FACT marked "\(Cue's read: …\)" are Cue's own paraphrase and never support a claim; only the page's quoted words and its listed fields do/.test(readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8")));
check("the record note counts the read's fields as stored", T.storedFields(SENT[1]).have.includes("its date and time") && T.storedFields(SENT[1]).have.some((h) => /who it's for/.test(h)));
check("only a v1 read in its stored shape is taken; anything else is no read", T.readOnFile(READS.sglang) !== null && T.readOnFile({ v: 2, facts: [] }) === null && T.readOnFile({ v: 1, facts: "x" }) === null && T.readOnFile(null) === null);
const tc = readFileSync(new URL("../../src/services/turnContext.ts", import.meta.url), "utf8");
check("the stored match.read is loaded with the sent find", /opportunityRead: readOnFile\(m\.read\)/.test(tc) && /had\.opportunityRead \?\?= item\.opportunityRead/.test(tc));

// ---------------------------------------------------------------- the claim read's rule
const rg = readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8");
check("the claim read types a page-stated audience, host or format as a detail backed by its event's FACT", /who it's for or what happens there as its page states it/.test(rg) && /An event's stated audience, hosts or format, said as what its page says, is a detail, supported by that event's FACT/.test(rg));
check("... while who will actually be in the room stays other_person", /saying who will actually be in the room \("a room full of engineers", "you'll meet the SGLang team"\) stays other_person/.test(rg) && /or who specifically will be somewhere/.test(rg));

console.log(`read facts: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
