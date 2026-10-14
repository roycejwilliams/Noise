// Model-free checks for the independent review of PR 46 (2026-10-05): the cases that review proved on the
// merged code. Names that are common words, Co's reply logged as several lines, a missing name, the yes
// check, the duplicate guard, and the pronoun backup's grammar. No API calls, no database:
//   npx tsx evals/calls/pr46Review.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const CC = await import("../../src/services/callContext.js");
const PW = await import("../../src/harness/profileWrite.js");
const TS = await import("../../src/services/textStyle.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

// ---- a member whose name is also a word
check("a member named Will: the verb 'will' is not them, so Jordan's 'He' stays Jordan's", CC.neutralMemberPronouns("Will talked about Jordan, who will join. He is a designer.", "Will") === "Will talked about Jordan, who will join. He is a designer.");
check("a member named May: 'may' is a verb", CC.neutralMemberPronouns("May talked about Jordan, who may join. He is a designer.", "May") === "May talked about Jordan, who may join. He is a designer.");
check("a member named Mark: the capitalised name still counts", CC.neutralMemberPronouns("Mark said his cofounder Dana quit. She is leaving.", "Mark") === "Mark said their cofounder Dana quit. She is leaving.");
check("a member named Grace: 'grace' in a sentence is not them", CC.neutralMemberPronouns("Grace talked about Jordan, who handled it with grace. He is calm.", "Grace") === "Grace talked about Jordan, who handled it with grace. He is calm.");

// ---- Co's reply is several texts, one line each
const beats = (...lines: string[]) => lines.map((l) => `Co replied: ${l}`).join("\n");
const offerThenLink = `${beats("Want me to look for founder communities in SF?", "https://example.com/communities")}\nUser said: yes please`;
check("an offer followed by a link, then a yes, is still a yes to the offer (it isn't dropped as Cue's echo)", PW.echoesCoNotMember("founder communities in SF", offerThenLink) === false);
const offerThenBeat = `${beats("Want me to look for founder communities in SF?", "No pressure either way.")}\nUser said: yeah do it`;
check("an offer followed by a softener, then a yes, likewise", PW.echoesCoNotMember("founder communities in SF", offerThenBeat) === false);
check("Cue's own plan, then another beat, then 'sure' is still not their want", PW.echoesCoNotMember("dig into sponsors for the event", `${beats("I'll dig into sponsors for the event.", "Back soon.")}\nUser said: sure`) === true);
const draft = "Good, keep going. Have a look at the cap table too.\n\nWhat's the number you're raising?";
const recent = `${beats("What's the number you're raising?")}\nUser said: not sure yet\n${beats("Fair enough.", "Think it over.")}\nUser said: ok`;
check("a question in Cue's previous turn is caught even though the turn after it was two beats", !TS.dropRepeatedQuestion(draft, recent).includes("What's the number you're raising?"));
check("several beats of one turn are read as one message", !TS.dropRepeatedQuestion(draft, beats("Got it, that's a big week.", "What's the number you're raising?") + "\nUser said: hmm").includes("What's the number you're raising?"));

// ---- no first name on file
check("with no name the summary stays grammatical: 'The member', never 'They is'", CC.fillMemberName("{M} is building a startup. {M}'s cofounder quit. {M} wants to surround {M}self with good people.", null) === "The member is building a startup. The member's cofounder quit. The member wants to surround themself with good people.");
check("a lowercase or spaced placeholder is filled too", CC.fillMemberName("{m} is tired. { M } slept.", "Royce") === "Royce is tired. Royce slept.");
check("a name on file still fills", CC.fillMemberName("{M}'s cofounder is from Texas.", "Royce") === "Royce's cofounder is from Texas.");

// ---- the yes check
const yes = (t: string) => PW.agreesWith(`User said: ${t}`);
for (const t of ["sure, why not", "yes, I don't mind", "yeah, no problem", "yes please", "sounds good, no worries", "yep go for it"]) check(`a real yes is a yes: ${t}`, yes(t));
for (const t of ["of course not", "yes, I mean no, forget that", "yes but not this week", "sure, never mind", "yeah nope", "sure, not right now"]) check(`a yes taken back is not: ${t}`, !yes(t));
check("a yes answers an offer", PW.lastAskedSentence("Co replied: Want me to look for founder communities in SF?") === "Want me to look for founder communities in SF?");
check("but not a check-in question: 'did it go well?' is not an offer", PW.lastAskedSentence("Co replied: Did the founder communities in SF meetup go well?") === null);
check("'should I', 'would you like' and 'can I' are offers", PW.lastAskedSentence("Co replied: Should I send the list over?") !== null && PW.lastAskedSentence("Co replied: Would you like me to ask them?") !== null);
check("a passing yes to a check-in question no longer lifts the echo guard", PW.echoesCoNotMember("founder communities in SF", "Co replied: Did the founder communities in SF meetup go well?\nUser said: yeah it was fine") === true);

// ---- promise results: no duplicates, no pile-up
const mig = read("src/db/migrations.ts");
const cg = read("src/harness/callGrounding.ts");
check("a duplicate guard on the table: one row per call and result", /CREATE UNIQUE INDEX IF NOT EXISTS uq_call_promise_results ON call_promise_results \(user_id, call_key, md5\(content\)\)/.test(mig));
check("the write ignores a duplicate, and old rows are removed", /ON CONFLICT DO NOTHING/.test(cg) && /DELETE FROM call_promise_results WHERE created_at < NOW\(\) - INTERVAL '14 days'/.test(cg));

// ---- the pronoun backup's grammar
check("'give her a call' about the member is 'give them a call'", CC.neutralMemberPronouns("Royce wants to give her a call.", "Royce") === "Royce wants to give them a call.");
check("'her' before a noun is still 'their'", CC.neutralMemberPronouns("Royce said her startup is growing.", "Royce") === "Royce said their startup is growing.");
check("the verb agrees: 'he loves it' is 'they love it'", CC.neutralMemberPronouns("Royce said he loves it and he starts Monday.", "Royce") === "Royce said they love it and they start Monday.");
check("is, was and has already agreed", CC.neutralMemberPronouns("Royce said he is tired and he has a call.", "Royce") === "Royce said they are tired and they have a call.");

console.log(`pr46 review rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
