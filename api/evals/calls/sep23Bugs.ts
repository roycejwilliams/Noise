// Checks for the five bugs from Royce's 2026-09-23 test call and the texts
// around it. No network.
//
//   npx tsx evals/calls/sep23Bugs.ts
import { readFileSync } from "fs";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { dropRepeatedQuestion } = await import("../../src/services/textStyle.js");
const { stripUnsupported } = await import("../../src/harness/replyGrounding.js");

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

// ---------------------------------------------------------------- #4 texts during call trouble
const convo = `User said: Try again I had my phone on dnd
Co replied: Weird, not sure why it's not connecting. Want to start with the venue types to call, or the questions to ask when you get someone on the phone?
User said: What's breaking?
Co replied: Honestly not sure. Want to start with the venue types to call, or the questions to ask when you get someone on the phone?`;
const again = dropRepeatedQuestion("Fair enough, that's on my side.\n\nVenue list still needs building either way. Want to start with the types to call or the questions to ask when you get someone on the phone?", convo);
check("#4 the same question isn't asked a third time", !/\?/.test(again) && again.startsWith("Fair enough, that's on my side."));
check("#4 a new question still goes out", dropRepeatedQuestion("Glad that's sorted. How did the permit call go?", convo) === "Glad that's sorted. How did the permit call go?");
check("#4 a reply that's only the repeated question is left alone (never empty)", dropRepeatedQuestion("Want to start with the venue types to call?", convo) === "Want to start with the venue types to call?");
{
  // Code review 2026-09-24: Co's texts are paragraphs; the question is in the last one.
  const paras = `User said: Try again
Co replied: Weird, not sure why it's not connecting.

Want to start with the venue types to call, or the questions to ask when you get someone on the phone?
User said: What's breaking?`;
  check("#4 a question in a later paragraph of Co's text counts as asked", !/\?/.test(dropRepeatedQuestion("That's on my side.\n\nWant to start with the venue types to call, or the questions to ask?", paras)));
  check("#4 'Co called' and photo lines end Co's message", dropRepeatedQuestion("Ok then. Want to start with the venue types to call?", "Co replied: hi\nUser sent a photo or voice memo (name/email intake)\nWant to start with the venue types to call?") === "Ok then. Want to start with the venue types to call?");
  check("#4 a gap marker ends Co's message", dropRepeatedQuestion("Ok. Want to start with the venue types to call?", "Co replied: hi\n[— 2 hours later —]\nWant to start with the venue types to call?") === "Ok. Want to start with the venue types to call?");
  const short = "Co replied: Nice. How's the permit going?\nUser said: slow";
  const longer = "Got it, that sounds slow. How's the permit going, and did the venue get back about the Saturday date?";
  check("#4 a new question that only contains an earlier short one still goes out", dropRepeatedQuestion(longer, short) === longer);
}
check("#4 no earlier question, nothing changes", dropRepeatedQuestion("Want to start with the venue types to call?", "User said: hi") === "Want to start with the venue types to call?");
const stripped = stripUnsupported(
  "Nothing's changed on my end that I'd call an upgrade, so not sure what you mean by that.\n\nLet's not lose the 18 days we've got though. Want to start with the venue types?",
  [
    { name: "claim_detail", pass: false, reason: `detail: "Let's not lose the 18 days we've got though."` },
    { name: "claim_capability", pass: false, reason: `capability: "Nothing's changed on my end that I'd call an upgrade"` },
  ],
);
check("#4 a claim either check flagged is removed", !/Nothing's changed/.test(stripped) && !/18 days/.test(stripped));
const rg = src("harness/replyGrounding.ts");
// Remove-only (2026-09-28): the cut drops what the first check flagged and what
// code flags on the cut; a rewrite is only kept when its own check finds nothing.
check("#4 nothing either check flagged goes out", /let cut = stripUnsupported\(draft, effectiveFailed1\);/.test(rg) && /if \(cutCode\.length\) cut = stripUnsupported\(cut, cutCode\);/.test(rg) && /if \(!failed2\.length\) kept = \{ text: cleaned, checks: r\.checks \};/.test(rg));
check("#4 a failed call's real reason reaches the reply", /memory_type = 'call_failure'/.test(rg) && /the problem is on your side, not their phone/.test(rg));
const calls = src("services/elevenLabsCalls.ts");
check("#4 a call that can't connect is noted in plain words, once per 10 min", /noteCallFailure\(userId, "registration"\)/.test(src("routes/co.ts")) && /a problem with Co's own voice setup/.test(calls) && /INTERVAL '10 minutes'/.test(calls));
check("#4 the reply is told to follow where they went", /If they moved on from a question you asked, go where they went; don't ask it again\./.test(src("agent/conversationReply.ts")));

// ---------------------------------------------------------------- #2 Co's words aren't their wants
{
  const { echoesCoNotMember } = await import("../../src/harness/profileWrite.js");
  const call = `assistant: Like are they helping you bring people to the event, or is it more about building out what Co can actually do?
user: i'm pretty much at the point now with code that um i'm ready to get hands off of coding. I am running to the problem where i'm not as network as her.
user: Um, probably my co founder'cause we're both from texas. I wanna continue to keep building with like minded individuals like that. just having that sense of community that just very important.
user: Ah, very down to earth and laid back like I feel like a lot of bloated egos in the tech space. somebody dependable and you know intelligent.
assistant: I'll keep that in mind. After we hang up I'll dig into those founder, tech, design, and product communities in SF and text you if something real fits.
user: Honestly, just a friend. somebody they can kinda go through battles with and you know, depend on.`;
  check("#2 Co's own line is not saved as their want", echoesCoNotMember("founder, tech, design, and product communities in SF", call));
  check("#2 their real ask is kept", !echoesCoNotMember("Looking to connect with down to earth, laid back people without inflated egos in the tech space", call));
  check("#2 their real want is kept", !echoesCoNotMember("people to go through battles with and depend on", call));
  check("#2 something both said is kept", !echoesCoNotMember("building with like minded individuals", call));
  // Code review 2026-09-24: an ask they said yes to is theirs.
  const agreed = `assistant: Want me to look for founder communities in SF?
user: Yes please`;
  check("#2 Co's offer they said yes to is kept", !echoesCoNotMember("founder communities in SF", agreed));
  check("#2 a yes by text counts too", !echoesCoNotMember("founder communities in SF", "Co replied: Nice.\n\nShould I look for founder communities in SF?\nUser said: yeah that'd be great"));
  check("#2 'okay' to Co's own plan is still not their want", echoesCoNotMember("founder communities in SF", "assistant: I'll dig into founder communities in SF after this.\nuser: sure"));
  check("#2 a no isn't agreement", echoesCoNotMember("founder communities in SF", "assistant: Want me to look for founder communities in SF?\nuser: nah not really"));
  // Text history has other labeled lines (sendblue.ts, co.ts); they're never Co's words.
  check("#2 a voice memo after Co's text is theirs, not Co's", !echoesCoNotMember("founder communities in SF", "Co replied: Nice.\n\nWhat kind of people?\nUser sent a voice memo: honestly founder communities in SF\nuser: ok\nassistant: founder communities in SF, got it"));
  check("#2 a paragraph of Co's text that starts with 'Co' is still Co's", echoesCoNotMember("founder communities in SF", "Co replied: Got it.\n\nCo will look at founder communities in SF.\nUser said: cool thanks"));
  check("#2 a text turn with no Co line is never filtered", !echoesCoNotMember("founder communities in SF", "user: looking for founder communities in SF"));
  const pe = src("services/profileExtraction.ts");
  check("#2 captureIntent filters asks, wants and preferences", /const mine = \(x: unknown\) => typeof x === "string" && !echoesCoNotMember\(x, transcript\);/.test(pe) && /\.filter\(\(a\) => mine\(a\.text\)\)/.test(pe));
}

// ---------------------------------------------------------------- #1 promises Co makes on a call
{
  const cg = src("harness/callGrounding.ts");
  check("#1 a promise Co volunteers on a call runs a real search", /await keepCallPromise\(userId, c\.what, transcript\)/.test(cg) && /attemptEventSurfacing\(\{\n\s+askId: `\$\{PROMISE_ASK_PREFIX\}\$\{key\}`/.test(cg));
  check("#1 the search never says they asked for it", /askText: what,\n\s+fromProfile: true,/.test(cg));
  check("#1 what came of it is recorded either way", /"promise_result"/.test(cg) && /found nothing good enough to send yet/.test(cg));
  const sweep = src("services/eventSurfacingSweep.ts");
  check("#1 a sent offer for a promise doesn't touch ask_checkins", /\} else if \(!askId\.startsWith\(PROMISE_ASK_PREFIX\)\) \{/.test(sweep));
  const pc = src("jobs/postCallFollowUp.ts");
  check("#1 (#6) promise results are tied to their call by its transcript, not a time window", /FROM call_promise_results WHERE user_id = \$1 AND call_key = \$2/.test(pc) && /callKey\(transcript\)/.test(pc) && !/INTERVAL/.test(pc.slice(pc.indexOf("What came of anything"), pc.indexOf("return draftPostCallText"))));
  check("#1 (#6) the search records its result against the same call", /INSERT INTO call_promise_results \(user_id, call_key, content\)/.test(cg) && /CREATE TABLE IF NOT EXISTS call_promise_results/.test(src("db/migrations.ts")));
  check("#1 the after-call text hears what the promise turned up", /what_co_said_it_would_look_into:/.test(pc) && /without promising to keep looking/.test(pc));
  const { callKey } = await import("../../src/services/callKey.js");
  check("#1 (#6) two calls get different keys, the same call the same key", callKey("user: hi\nassistant: hey") === callKey("user: hi\nassistant: hey") && callKey("user: hi") !== callKey("user: hi again"));
}

// ---------------------------------------------------------------- #3 and #5 the call's end and its summary
{
  const prompt = readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
  check("#3 'sounds good' / 'thank you' are not goodbyes", /"Sounds good," "thank you," and "okay" are them answering what you just said, not a goodbye/.test(prompt));
  check("#3 the close ends with a spoken goodbye, said once, only at the real end, then end_call (2026-10-08: a goodbye after an ordinary tool turn, and \"Still there?\" after a goodbye)", /Say that goodbye once/.test(prompt) && /end the call with end_call and say nothing more/.test(prompt) && /only at the real end of the call/.test(prompt) && /never sign off at the end of an ordinary turn/.test(prompt) && /never asking whether they're still there/.test(prompt));
  check("#3 every name placeholder is one Hume fills in", !/(?<!\{)\{first_name\}(?!\})/.test(prompt));
  const { callSummaryPrompt } = await import("../../src/services/callContext.js");
  const sp = callSummaryPrompt("user: hi");
  check("#3 how the call ended comes from their words, not a voice reading", /How the call ended comes only from what they said at the end, never from a voice reading/.test(sp) && !/voice analysis/i.test(sp));
  check("#5 named companies, people, dates and plans come first", /Lead with the concrete facts they gave/.test(sp) && /Keep every named company and person they mentioned/.test(sp));
  check("#5 spelled-out names are written as names", /"l y t h e dot a i" is lythe\.ai/.test(sp));
  const { neutralMemberPronouns } = await import("../../src/services/callContext.js");
  check("#5 summaries never guess the member's pronouns", neutralMemberPronouns("Royce discussed his startup. He sounded tired.", "Royce") === "Royce discussed their startup. They sounded tired." && /const summary = fillMemberName\(raw\.trim\(\), firstName\);/.test(src("services/callContext.ts")));
  // Code review 2026-09-24: someone else's news isn't pinned on the member.
  check("#5 another person's pronoun is left alone", neutralMemberPronouns("Royce talked about their cofounder Maya. She is leaving the company.", "Royce") === "Royce talked about their cofounder Maya. She is leaving the company.");
  check("#5 the member's own pronoun before the other person is still fixed", neutralMemberPronouns("Royce said his cofounder Maya is leaving.", "Royce").startsWith("Royce said their cofounder Maya"));
  check("#5 naming the member again brings 'they' back", neutralMemberPronouns("Maya is leaving. Royce sounded worried about it, and he wants a new partner.", "Royce") === "Maya is leaving. Royce sounded worried about it, and they want a new partner." || neutralMemberPronouns("Maya is leaving. Royce sounded worried about it, and he wants a new partner.", "Royce").includes("and they"));
  check("#5 a company or place isn't another person", neutralMemberPronouns("Royce is building Lythe.ai with a partnership at Sangria in San Francisco. He sounded excited.", "Royce").endsWith("They sounded excited."));
  check("#5 line breaks in the summary are kept", neutralMemberPronouns("Royce is tired.\n\nHe sounded flat.", "Royce") === "Royce is tired.\n\nThey sounded flat.");
  check("#5 unknown name still neutralizes a summary about only them", neutralMemberPronouns("He sounded tired.", null) === "They sounded tired.");
}

// ---------------------------------------------------------------- run-ons and stutters on the call
{
  const prompt = readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
  check("speech: no dashes anywhere in the call prompt (Co copies its style; a spoken dash is a run-on)", !/[—–]/.test(prompt));
  check("speech: short spoken sentences, never a dash", /Short sentences, one thought each/.test(prompt) && /Never put a dash in what you say/.test(prompt));
  check("speech: one question per turn, never re-asked in other words", /Ask one question per turn\./.test(prompt) && /never follow it with the same question in other words/.test(prompt));
  check("speech: 'hello?' mid-call means the line seemed to drop, not a new call", /say you're still here and pick up where you were, never greet them like a new call/.test(prompt));
}

// ---------------------------------------------------------------- second review of PR 46 (2026-09-24)
{
  const { neutralMemberPronouns } = await import("../../src/services/callContext.js");
  const cases: [string, string, string | null, string][] = [
    ["#1 a name after 'about' keeps its own pronoun", "Royce talked about Maya. She is leaving the company.", "Royce", "Royce talked about Maya. She is leaving the company."],
    ["#1 a name after 'for' keeps its own pronoun", "Royce is worried for Jordan. He just lost his job.", "Royce", "Royce is worried for Jordan. He just lost his job."],
    ["#1 a name after 'to' keeps its own pronoun", "Royce introduced Co to Ellis. She runs a design studio.", "Royce", "Royce introduced Co to Ellis. She runs a design studio."],
    ["#1 'his cofounder' then 'She' stays with the cofounder", "Royce said his cofounder is leaving. She is nervous.", "Royce", "Royce said their cofounder is leaving. She is nervous."],
    ["#2 'friends' doesn't stop the member's fix", "Royce wants to make new friends. He sounded hopeful.", "Royce", "Royce wants to make new friends. They sounded hopeful."],
    ["#2 'investors' doesn't stop the member's fix", "Royce is pitching investors next week. He sounded nervous.", "Royce", "Royce is pitching investors next week. They sounded nervous."],
    ["#3 a verb starting a sentence isn't a person", "Mentioned his startup is struggling. He sounded flat.", "Royce", "Mentioned their startup is struggling. They sounded flat."],
    ["#3 Hume isn't a person", "Hume's reading suggested he was anxious.", "Royce", "Hume's reading suggested they were anxious."],
    ["#3 a hyphenated name is the member", "Mary-Kate discussed her startup.", "Mary-Kate", "Mary-Kate discussed their startup."],
    ["#3 'her' before a noun is 'their', otherwise 'them'", "Jordan said her team surprised her.", "Jordan", "Jordan said their team surprised them."],
  ];
  for (const [label, input, name, want] of cases) check(label, neutralMemberPronouns(input, name) === want);

  const { fillMemberName, callSummaryPrompt: sumPrompt } = await import("../../src/services/callContext.js");
  check("summary: the member is written as {M}, never a pronoun", /Write the person on the call as \{M\} every time, never a pronoun for them/.test(sumPrompt("user: hi")) && /const summary = fillMemberName\(raw\.trim\(\), firstName\);/.test(src("services/callContext.ts")));
  check("summary: {M} is filled with their name, possessive kept", fillMemberName("{M} is building Co. {M}'s cofounder is from Texas.", "Royce") === "Royce is building Co. Royce's cofounder is from Texas.");
  check("summary: '{M}self' is 'themself', not 'Royceself'", fillMemberName("{M} wants to surround {M}self with good people.", "Royce") === "Royce wants to surround themself with good people.");
  check("summary: a leftover 'he' about someone else stays", fillMemberName("{M} talked about Maya. She is leaving.", "Royce") === "Royce talked about Maya. She is leaving.");
  const { echoesCoNotMember, agreesWith } = await import("../../src/harness/profileWrite.js");
  check("#4 a yes to an unrelated question doesn't claim Co's plan (text)", echoesCoNotMember("founder communities in SF", "Co replied: I'll dig into founder communities in SF after this.\n\nHow was your weekend?\nUser said: yeah it was great"));
  check("#4 a yes to an unrelated question doesn't claim Co's plan (call)", echoesCoNotMember("founder communities in SF", "assistant: I'll dig into founder communities in SF. Did you eat yet?\nuser: yeah I did"));
  check("#4 a yes to the offer itself still counts", !echoesCoNotMember("founder communities in SF", "assistant: Want me to look for founder communities in SF?\nuser: yes please"));
  check("#5 'of course not' isn't a yes", !agreesWith("user: of course not") && echoesCoNotMember("founder communities in SF", "assistant: Want me to look for founder communities in SF?\nuser: of course not"));
  check("#5 'yes, I mean no' isn't a yes", !agreesWith("user: yes, I mean no, forget that"));
  check("#5 'sure, no worries' is still a yes", agreesWith("user: sure, no worries"));
}

console.log(`sep 23 call bugs: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
