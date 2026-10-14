// Model-free checks for matching at events Co doesn't run (2026-09-23): only
// people who said they're going count, the heads-up names no one until both
// say yes, and the overlap is measured. No network.
//
//   npx tsx evals/outsideEvents/rules.ts
import { readFileSync } from "fs";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { attendeesOnly, pickCanonicalEventId } = await import("../../src/services/eventMatching.js");
const { anonymousHeadsUpPrompt } = await import("../../src/services/eventScoring.js");
const { describeOpenItem } = await import("../../src/services/messageRouter.js");

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- only people going
const found = [
  { user_id: "a", event_api_id: null, source: "mention" as const },
  { user_id: "b", event_api_id: "evt-real", source: "surfaced" as const },
];
check("a member Cue only recommended the event to is not counted as going", JSON.stringify(attendeesOnly(found).map((m) => m.user_id)) === '["a"]');
check("but the recommended event still lends its real id", pickCanonicalEventId(found, ["me", "a"]) === "evt-real");
const em = src("services/eventMatching.ts");
check("recommending an event no longer matches anyone", !/scoreMatchedGroup\(eventApiId/.test(em) && /Recorded only \(2026-09-23\)/.test(em));
check("mention matching uses attendees only", /const matches = attendeesOnly\(found\);/.test(em));

// ---------------------------------------------------------------- no names until both yes
const prompt = anonymousHeadsUpPrompt({ recipientFirstName: "Jordan", eventName: "Climate Week mixer", shareReason: "you're both building in climate hardware", feedback: null });
check("heads-up prompt: never given the other person's name", !/Sam|otherFirstName/.test(prompt) && /without anything that would identify who it is/.test(prompt));
check("heads-up prompt: asks, and says who comes after both agree", /asks if they'd like an intro/.test(prompt) && /once you've checked with them too/.test(prompt));
const sc = src("services/eventScoring.ts");
check("heads-up draft is rejected if it names them anyway", /extraDraftChecks: \(d\) => \[checkNamesWithheld\(d, \[candidate\.first_name\]\)\]/.test(sc));
check("the queued summary carries no name", /summary: `Heads-up that another member they'd get along with is also going/.test(sc));
check("the nudge is recorded as anonymous", /anonymous: true,\n\s+\};/.test(sc) && /markMatchNudgeSent\(p\.eventId, c\.userId, p\.candidateId, p\.score, !!p\.anonymous\)/.test(src("harness/proactiveRegistry.ts")));
check("the saved note carries no name", /p\.anonymous\n\s+\? `Told them another member who's also going to the same thing could be worth meeting, without saying who/.test(src("harness/proactiveRegistry.ts")));
check("open item: no name when anonymous", describeOpenItem("match_nudge", null).includes("without saying who") && !describeOpenItem("match_nudge", null).includes("null"));
check("open item: the router never passes the name for an anonymous one", /matchNudge\.anonymous \? null : matchNudge\.candidate_first_name/.test(src("services/messageRouter.ts")));
const sb = src("routes/sendblue.ts");
const block = sb.slice(sb.indexOf("const other = pendingMatchNudge.anonymous"), sb.indexOf('console.error("sendblue: match nudge reply handling failed'));
check("reply after their yes: no name, and told not to hint", block.length > 0 && !block.includes("${pendingMatchNudge.candidate_first_name}") && /Don't name them, describe them, or hint at who it is/.test(block));
check("the anonymous flag is stored and read back", /ADD COLUMN IF NOT EXISTS anonymous BOOLEAN NOT NULL DEFAULT false/.test(src("db/migrations.ts")) && /n\.anonymous/.test(src("services/eventGuestMatchHandoff.ts")));

// ---------------------------------------------------------------- measured
check("each outside event with 2+ members going is logged", /decision: "event\.overlap"/.test(em));
check("the weekly review prints the overlap numbers", /outsideEventOverlapStats\(30\)/.test(src("scripts/weeklyReview.ts")));

console.log(`outside event rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
