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

console.log(`grader with context (live): ${total - failed}/${total} passed`);
if (failed) process.exit(1);
