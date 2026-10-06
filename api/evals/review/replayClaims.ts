// Replays a real review window from a JSON dump of its rows, with and
// without the week before, and prints the "unbacked claim" flags each way
// (2026-09-26: the review called two true claims invented because it only
// saw the day's log). The dump is loadReviewData's queries as JSON.
//
//   railway run --service co-test --environment dev -- npx tsx evals/review/replayClaims.ts <dump.json> [runs]
import "../lib/requireMeter.js";
import { readFileSync } from "fs";

const { reviewDataFromRows, modelFlags } = await import("../../src/harness/devReview.js");
const dump = JSON.parse(readFileSync(process.argv[2], "utf8"));
const runs = Number(process.argv[3] ?? 2);
const data = reviewDataFromRows({ userId: dump.userId, firstName: "Royce", msgs: dump.msgs, decisions: dump.decisions, emotions: [], issues: [], asks: dump.asks, earlierMem: dump.earlierMem, earlierSends: dump.earlierSends });
console.log(`earlier record: ${data.earlier?.sent.length} sent, ${data.earlier?.theySaid.length} said`);

for (const withEarlier of [false, true]) {
  for (let i = 0; i < runs; i++) {
    const d = withEarlier ? data : { ...data, earlier: { sent: [], theySaid: [] } };
    const flags = (await modelFlags(d)).filter((f) => f.type === "contradiction_or_unbacked_claim");
    console.log(`\n${withEarlier ? "WITH" : "WITHOUT"} the week before, run ${i + 1}: ${flags.length} unbacked-claim flag(s)`);
    for (const f of flags) console.log(`  [${f.severity}] ${f.snippet}\n     ${f.cause}`);
  }
}
