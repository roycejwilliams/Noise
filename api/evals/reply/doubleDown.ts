// Reply path: Co must not defend its own earlier text as the source of what the member said (Royce, 2026-10-06). Layer 1.
//   npx tsx evals/reply/doubleDown.ts
// The incident: a check-in said "That's going to come through Friday". They asked "What's Friday?" and Co replied "Friday's the pitch
// you've been prepping the investor ask for, that's what I meant." That was its own earlier text, nothing they said lately.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const G = await import("../../src/harness/replyGrounding.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const fails = (draft: string, s: { message: string; recentConversation: string; recentMemories?: string }, rf = G.baseReplyFacts()) => G.codeChecks(draft, rf, s).filter((c) => !c.pass).map((c) => c.name);

const THREAD = "Co replied: The scarcity angle, building to acquire, bringing on an advisor with equity. That's going to come through Friday even if the ask part feels shaky.";
const ASK = { message: "What's Friday?", recentConversation: THREAD, recentMemories: "User said on September 29, 2026: I am pitching investors Friday and I keep freezing on the ask." };
const DOUBLE_DOWN = "Friday's the pitch you've been prepping the investor ask for, that's what I meant.";

check("replay: defending its own earlier text as 'the pitch you've been prepping' is stopped", fails(DOUBLE_DOWN, ASK).includes("no_unsourced_attribution"));
check("an old memory of theirs (a week back) does not make 'you've been prepping' current", fails("Right, the investor pitch you've been prepping.", ASK).includes("no_unsourced_attribution"));
check("owning it passes: 'I don't have that from you, I shouldn't have said Friday'", !fails("I don't have a Friday from you. I shouldn't have said it like it was something you'd told me.", ASK).includes("no_unsourced_attribution"));
check("asking passes: 'Is something coming up Friday?'", !fails("Is anything happening Friday I should know about?", ASK).includes("no_unsourced_attribution"));
check("what they said in this thread, recently, can be stated back", !fails("You told me you're pitching investors, so I assumed that was it.", { message: "ok", recentConversation: "User said: I'm pitching investors this week\nCo replied: got it" }).includes("no_unsourced_attribution"));
check("what they said in this very message can be stated back", !fails("You said you're weighing a raise, so let's start there.", { message: "I'm weighing a raise and don't know how to ask", recentConversation: "" }).includes("no_unsourced_attribution"));
check("Co's own earlier line never counts as their words", fails("You've been prepping the investor ask.", { message: "huh", recentConversation: "Co replied: you've been prepping the investor ask for Friday" }).includes("no_unsourced_attribution"));
const rf = G.baseReplyFacts();
G.addFact(rf, "known", "What they have told Co that still holds (each with when they said it): They want an advisor paid in equity. (they said, Oct 5).");
check("a live claim given to the reply backs it (they did say it, and it still holds)", !fails("You told me you want an advisor paid in equity.", { message: "what do you remember", recentConversation: "" }, rf).includes("no_unsourced_attribution"));
check("an ordinary reply with no attribution is untouched", fails("Sounds like a plan. Want me to look for options?", ASK).length === 0);

// wiring: the reply is handed what they have told Co (with when), and the rule for being asked what Co meant
const sb = src("routes/sendblue.ts");
check("the reply is given their live claims, labelled with when", /What they have told Co that still holds \(each with when they said it\)/.test(sb) && /heldClaimsFrom\(turn\?\.knowledge\)/.test(sb) && /return renderLive\(k\.claims\.map/.test(src("harness/replyGrounding.ts")));
check("and told: answer a challenge only from what they said, own the slip, never defend its own earlier text", /Your own earlier texts are never the source of what they said; never defend one/.test(sb) && /say you don't have that from them and own the slip/.test(sb));
check("the check is in the reply gate's code checks, not only in a prompt", /name: "no_unsourced_attribution"/.test(src("harness/replyGrounding.ts")) && /attributedWithoutSource\(draft/.test(src("harness/replyGrounding.ts")));
console.log(`reply double-down: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
