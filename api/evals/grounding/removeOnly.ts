// Live check of the remove-only fact check (harness/replyGrounding.ts) on
// the 09-28 real drafts. OLD=1 runs the last committed version for a
// before/after (needs src/harness/replyGroundingOld.ts). Nothing is sent.
//
//   railway run --service co-test --environment dev -- npx tsx evals/grounding/removeOnly.ts
import "../lib/requireMeter.js";
const G: any = process.env.OLD ? await import("../../src/harness/replyGroundingOld.js") : await import("../../src/harness/replyGrounding.js");
const grok = 'Details on file for "Grok Bot x Notion for Product Builders night (SF)", which Cue sent them: "Grok Bot x Notion for Product Builders night (SF)" starts Tuesday, September 29 at 5:00 PM (America/Los_Angeles).';
const dayt = 'Cue sent them "daytonaio AI Builders Demo Night" (https://x.com/i/status/2102773693290336381); Cue has no start time or address for it beyond what that post says: "Excited for next Tuesday, Sept 29, and our monthly @daytonaio AI Builders Demo Night in SF! We\'re hosting at @WorkOS SF Office in partnership with @llama_index."';
const convo = [
  "Co replied: https://lu.ma/grokbotproduct-sf",
  "Co replied: Short notice, but Grok Bot x Notion is throwing a product builders night in SF on Tuesday the 29th.",
  "Co replied: https://x.com/i/status/2102773693290336381",
  "Co replied: Found the SF meetup you asked about: daytonaio's AI Builders Demo Night, next Tuesday Sept 29 at WorkOS SF, with llama_index.",
  "User said: I'm in [Replying to Cue's text about daytonaio]",
  "Co replied: Good. Tuesday at WorkOS.",
].join("\n");
const cases = [
  { name: "11:22 pick", message: "I'm in [Replying to Cue's text: the Grok Bot link]", draft: "Both on the same night though, so it's really one or the other. Since you already called the daytonaio demo night your pick, I'd stick with that and just go be in the room this time.", want: (t: string) => /daytonaio/i.test(t) && !/grok|this one/i.test(t.replace(/daytonaio[^.]*/i, "")) && !/break|burn|output/i.test(t) },
  { name: "your crowd", message: "I'm in", draft: "Good pick. Tuesday at WorkOS, go find the llama_index people, that's your crowd.", want: (t: string) => !/your crowd|llama_index people/i.test(t) },
  { name: "why, untouched", message: "I'm in", draft: "Good. Could be a solid place to find the dependable builder people you're after.", want: (t: string, o: string) => o === "as_drafted" },
  { name: "noted that too", message: "We should find time and date for any event we surface", draft: "Agreed, noted that too. The Luma one is already with the team.", want: (t: string) => !/noted that too/i.test(t) },
];
let ok = 0;
for (const c of cases) {
  const rf = G.createReplyFacts();
  G.addFact(rf, "known", grok);
  G.addFact(rf, "known", dayt);
  G.addFact(rf, "known", 'Saved for the team in the last day: "Cue should extract and provide all available details (including start times) from Luma event links found in X posts." Nothing new was saved this turn.');
  const t = Date.now();
  const r = await G.groundReply(c.draft, rf, { message: c.message, recentConversation: convo, contextSummary: "", recentMemories: "", sentThisTurn: [] }, { record: false });
  const pass = c.want(r.final, r.outcome);
  if (pass) ok++;
  console.log(`${pass ? "ok  " : "MISS"} ${c.name} [${r.outcome}, ${Date.now() - t}ms${r.stages?.redraftMs ? `, rewrite ${r.stages.redraftMs}ms` : ""}]: ${r.final}`);
}
console.log(`${process.env.OLD ? "before" : "after"}: ${ok}/${cases.length}`);
