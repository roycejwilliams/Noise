// Live check (Layer 2, metered, Sonnet, about a cent): the source criteria judged WITH the call context (#113,
// services/callEvals.ts judgeWithContext). Correct recall from the context passes; a planted, deliberately wrong claim still fails.
//   railway run --service co-test --environment dev -- npm run -s eval:live -- evals/calls/graderContextLive.ts
import "../lib/requireMeter.js";
import "dotenv/config";
const { judgeWithContext } = await import("../../src/services/callEvals.js");

const given = `It is Thursday, October 8, 7:10 PM Pacific (their time).
Current situation (latest first):
- Oct 6: Jordan is planning a November open house for their design studio, about 40 people, at the studio in Hayes Valley.
Who they are: runs a small brand design studio (3 people) in SF, moved from New York two years ago; likes small dinners, hates big networking mixers; climbs on weekends.`;
const call = (co: string) => `assistant: Hey Jordan, it's Co.
user: Hey, um, things have been kind of slow at the studio honestly.
assistant: ${co}
user: Yeah, I guess so.`;

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}\n  ${JSON.stringify(detail).slice(0, 600)}`); } else console.log(`ok   ${label}`); };
const verdict = (vs: { id: string; result: string }[], id: string) => vs.find((v) => v.id === id)?.result;

const right = await judgeWithContext(call("Slow with three of you in the studio, and the open house for forty in Hayes Valley next month. Is it the work drying up, or not knowing what you want next?"), given);
check("correct recall from the context (three people, forty guests, Hayes Valley) passes both source criteria", verdict(right, "no_invented_specifics") === "success" && verdict(right, "no_unsaid_attribution") === "success", right);

const invented = await judgeWithContext(call("Slow even with the Brooklyn office opening on the 14th and the eight new hires. Is it the work drying up?"), given);
check("a planted invented fact (a Brooklyn office on the 14th, eight hires) still fails no_invented_specifics", verdict(invented, "no_invented_specifics") === "failure", invented);

const misattributed = await judgeWithContext(call("You told me last week you're thinking of closing the studio and moving back to New York. Is that still on your mind?"), given);
check("a planted misattribution (\"you told me you're closing the studio\") still fails no_unsaid_attribution", verdict(misattributed, "no_unsaid_attribution") === "failure", misattributed);

// Recall from the call reason (2026-10-08 eval, playful): the reason quoted them naming the newsletter; Co naming it first is recall.
const reasonGiven = `${given}\n\nCo called because of something in their life: their studio was featured in a design newsletter this week. They said: "we got into Design Digest".`;
const early = await judgeWithContext(`assistant: Hey Jordan, it's Co.\nuser: My open house got mentioned in this design newsletter!\nassistant: Design Digest, right? That's a real one.\nuser: Yes!`, reasonGiven, "", undefined, ["no_invented_specifics: Co named Design Digest before the member did."]);
check("a name from the call reason, said before the member says it, is recall, not invention", verdict(early, "no_invented_specifics") === "success", early);
// And a wrong time word against the clock still fails (2026-10-08 eval, stale_pushback: "yesterday, October 8th" on October 8).
const wrongDay = await judgeWithContext(`assistant: Hey Jordan, it's Co.\nuser: When did you send the plan?\nassistant: Yesterday, October 8th.\nuser: Ok.`, `${given}\n\nThey already have these:\n- Oct 8: the plan for after the open house (sent as a PDF).`);
check("\"yesterday, October 8th\" on October 8 fails against the clock", verdict(wrongDay, "no_invented_specifics") === "failure", wrongDay);

// A long call with the invented detail early: the judge reads the whole call and the first grader's flag, and still fails it.
const filler = Array.from({ length: 40 }, (_, i) => `user: Yeah, and the other thing on my mind is the lighting for the studio, option ${i + 1}, you know?\nassistant: That makes sense. Warm light suits the room.`).join("\n");
const long = `assistant: Hey Jordan, it's Co.\nuser: Things are slow.\nassistant: Slow even with the Brooklyn office opening on the 14th?\n${filler}\nuser: Ok, bye.`;
const longV = await judgeWithContext(long, given, "", undefined, ["no_invented_specifics: Co said 'the Brooklyn office opening on the 14th', which the member never mentioned."]);
check(`a long call's early invented detail (${long.length} chars) still fails with the first grader's flag`, verdict(longV, "no_invented_specifics") === "failure", longV);

console.log(`grader with context (live): ${total - failed}/${total} passed`);
if (failed) process.exit(1);
