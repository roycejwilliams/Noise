// No invented specifics in an unprompted message (harness/proactiveSpecifics.ts, wired into draftProactive). Layer 1: the model is a
// fake, zero tokens.
//   npx tsx evals/proactive/specifics.ts
//
// The regression (2026-10-06): a post-call text told a member their "scarcity angle and advisor structure would come through Friday", at
// "the pitch you've been prepping the investor ask for". On the call they had said nothing about a pitch or a Friday. "Friday" was a
// week-old relative date ("I am pitching investors Friday", said 9/29 for a Friday that had passed) that two recaps carried forward
// as "preparing to pitch Friday" in the background facts. The model projected it onto what it had just heard.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const S = await import("../../src/harness/proactiveSpecifics.js");
const P = await import("../../src/harness/proactive.js");
const { draftPostCallText } = await import("../../src/jobs/postCallFollowUp.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };

// ---------- the scenario, replayed through the real post-call draft
// What the call actually held: the scarcity angle, building to be acquired, an advisor paid in equity. No pitch, no day.
const TRANSCRIPT = [
  "assistant: Hey Royce, it's Co. How did the advisor conversation land?",
  "user: Good. I think the angle is scarcity. Co is built to create scarcity around the rooms, so it's something worth acquiring, not another app.",
  "assistant: And the advisor piece?",
  "user: I want to bring on an advisor with equity instead of just picking their brain. Someone who has done a consumer social pre-seed raise before.",
  "assistant: That sounds like a real structure.",
  "user: Yeah. I'm just not sure how to ask for it yet.",
].join("\n");
// What the member context said: the stale recap line that carried a week-old relative date forward.
const BACKGROUND = "Royce is building Co, a pre-seed social club platform. He's preparing to pitch investors Friday and has been working through freezing on \"the ask\", and is looking for an advisor with equity.";
const FABRICATED = "The scarcity angle, building to acquire, bringing on an advisor with equity instead of just picking their brain. You're not thinking about this casually, you've got a real structure in your head already. That's going to come through Friday even if the ask part feels shaky.";
const ASKS = "The scarcity angle and the advisor-with-equity structure sound like a real plan. Anything coming up this week I should know about?";
const invented = (t: string | null) => !!t && /\bfriday\b|\bpitch|\binvestor/i.test(t);

{
  const prompts: string[] = [];
  P.setProactiveModelForTests(async (prompt) => { prompts.push(prompt); return prompts.length === 1 ? FABRICATED : ASKS; });
  const r = await draftPostCallText("Royce", TRANSCRIPT, BACKGROUND);
  check("the replay: the fabricated Friday pitch is caught, and the redraft asks instead of stating", !!r && !invented(r.text) && /\?\s*$/.test(r.text) && r.text === ASKS);
  check("it took exactly one redraft, and the model was told which words to cut and to ask instead", prompts.length === 2 && /It broke: it states "Friday"/.test(prompts[1]) && /ask instead of stating/.test(prompts[1]));
  check("the draft prompt now says a date or event never comes from the background", /never a source for a date, an event or what they are preparing for/.test(prompts[0]));
}
{
  let n = 0;
  P.setProactiveModelForTests(async () => { n++; return FABRICATED; });
  const r = await draftPostCallText("Royce", TRANSCRIPT, BACKGROUND);
  check("a model that keeps inventing it is not sent at all (structurally impossible, not just discouraged)", r === null && n === 2);
}
{
  P.setProactiveModelForTests(async () => "Doing a daily check-in on how the advisor-with-equity idea is sitting with you after that call.");
  const r = await draftPostCallText("Royce", TRANSCRIPT, BACKGROUND);
  check("a general message with no specifics goes through untouched", !!r && /advisor-with-equity/.test(r.text));
}
{
  // Their own words on the call that just ended DO back a day: they said it.
  const t2 = `${TRANSCRIPT}\nuser: The pitch is Friday, so I need to nail the ask.`;
  P.setProactiveModelForTests(async () => "Hope the pitch goes well Friday. You've got the structure.");
  const ok = await draftPostCallText("Royce", t2, "");
  check("a Friday and a pitch the member said on the call just now are backed, and allowed", !!ok && /Friday/.test(ok.text));
  // ...but not when only Co said it on the call.
  const t3 = `${TRANSCRIPT}\nassistant: Good luck with the pitch Friday.`;
  P.setProactiveModelForTests(async () => "Hope the pitch goes well Friday. You've got the structure.");
  const no = await draftPostCallText("Royce", t3, "");
  check("a Friday or a pitch that only Co said on the call (repeating its background) is not backed", no === null);
}

// ---------- the guard itself
const U = (text: string, facts: any, o: any = {}) => S.unbackedSpecifics(text, facts, { now: new Date("2026-10-06T16:00:00Z"), ...o }).map((x) => x.text.toLowerCase());
check("a day in the background is never backed", U("Good luck Friday.", { background_you_already_knew: "preparing to pitch Friday" }).includes("friday"));
check("a day they said earlier, in an older text, is not backed (it has long since passed)", U("Good luck Friday.", { their_own_words_about_it: "I am pitching investors Friday" }).includes("friday"));
check("a day in a source marked fresh (the call that just ended) is backed", U("Good luck Friday.", { call_transcript: "user: it's Friday" }, { freshKeys: ["call_transcript"] }).length === 0);
check("a fresh transcript backs only what the MEMBER said, not what Co said in it", U("Good luck Friday.", { call_transcript: "assistant: Friday\nuser: ok" }, { freshKeys: ["call_transcript"] }).includes("friday"));
check("a future date in a structured field backs its weekday and its month and day", U("It's on Friday, October 9.", { the_date_they_gave: "2026-10-09" }).length === 0 && U("See you Oct 9.", { due: "2026-10-09" }).length === 0);
check("a past date backs nothing (the Friday that already went by)", U("Good luck Friday.", { the_date_they_gave: "2026-10-02" }).includes("friday"));
check("a date on a different day than the one on file is not backed", U("It's Saturday.", { the_date_they_gave: "2026-10-09" }).includes("saturday"));
check("an event time in a structured field backs the same time written another way", U("It starts at 7pm.", { starts_at_local_time: "7:00 PM" }).length === 0 && U("It starts at 8pm.", { starts_at_local_time: "7:00 PM" }).includes("8pm"));
check("tomorrow and today are backed only by a date on file that is tomorrow or today", U("It's tomorrow.", { the_date: "2026-10-07" }).length === 0 && U("It's tomorrow.", { the_date: "2026-10-09" }).includes("tomorrow") && U("It's tonight.", { the_date: "2026-10-06" }).length === 0);
check("asking about a generic window states nothing: allowed", U("Anything coming up this week I should know about?", {}).length === 0 && U("Anything this weekend?", {}).length === 0);
check("stating a generic window is a claim: not allowed", U("You have a lot on this week.", {}).includes("this week") && U("Call me tomorrow.", {}).includes("tomorrow"));
check("a weekday is never allowed as a question without backing either", U("Is Friday still on?", {}).includes("friday"));
check("an event they didn't tell you about is caught even with no date", U("How's the pitch prep going?", { background_you_already_knew: "preparing for a pitch" }).includes("pitch") && U("How did the investor meeting go?", {}).length === 2);
check("an event they actually said, or a structured field names, is backed", U("How's the pitch prep going?", { their_own_words_about_it: "freezing on the ask in my pitch" }).length === 0 && U("How did the meeting go?", { the_thing_they_are_in_the_middle_of: "a meeting with the departing founder" }).length === 0);
check("dates in many forms are all caught", ["Oct 14", "October 14th", "10/14", "2026-10-14", "at 3pm", "at 3:30 pm", "next week", "in 3 days", "end of the week", "this weekend", "tomorrow", "tonight"].every((t) => U(`Talk ${t}.`, {}).length >= 1));
check("ordinary text with no specifics is untouched", U("The advisor-with-equity structure sounds like a real plan. How is it sitting with you?", {}).length === 0);
check("plural and case don't hide a day", U("Tuesdays are hard.", {}).length === 1 && U("see you FRIDAY", {}).length === 1);

// ---------- wiring: no caller can opt out
const prosrc = src("harness/proactive.ts");
check("every proactive draft goes through the guard in draftProactive, with one redraft and then no send", /unbackedSpecifics\(first, opts\.facts/.test(prosrc) && /unbackedSpecifics\(second, opts\.facts/.test(prosrc) && /return null;\s*\}\s*$/m.test(prosrc.slice(prosrc.indexOf("not sent: it still states"), prosrc.indexOf("not sent: it still states") + 200)));
const callers = ["agent/eventChangeNotification.ts", "agent/windowFollowUp.ts", "agent/calendarFollowReachOut.ts", "agent/companionCheckin.ts", "agent/eventDiscoverySurfacing.ts", "agent/eventAskSolicitation.ts", "agent/askCheckin.ts", "harness/proactiveRegistry.ts", "jobs/postCallFollowUp.ts", "services/coEventAnnouncement.ts"];
check("none of the proactive message writers calls a model on its own (they all use draftProactive)", callers.every((f) => !/generateText\(/.test(src(f)) && /draftProactive\(/.test(src(f))));
check("the post-call text marks the call that just ended as fresh and its background as background", /freshKeys: \["call_transcript"\]/.test(src("jobs/postCallFollowUp.ts")) && /background_you_already_knew/.test(src("jobs/postCallFollowUp.ts")));
check("the companion check-ins keep their recap as background only", (src("agent/companionCheckin.ts").match(/recap_for_background_only|recap_of_what_you_know_about_them/g) ?? []).length >= 3);
check("the pre-arrival text gives its date as a date, so today and tonight are backed and nothing else is", /the_event_date: P\.localDate/.test(src("harness/proactiveRegistry.ts")) && S.unbackedSpecifics("It starts tonight at 7pm.", { starts_at_local_time: "7:00 PM", the_event_date: "2026-10-06" }, { now: new Date("2026-10-06T20:00:00Z") }).length === 0 && S.unbackedSpecifics("It starts Thursday at 7pm.", { starts_at_local_time: "7:00 PM", the_event_date: "2026-10-06" }, { now: new Date("2026-10-06T20:00:00Z") }).length === 1);

// ---- the reviewer's cases (2026-10-06)
check("an evening event stored as a UTC timestamp backs its LOCAL weekday (7pm PT Friday is Saturday in UTC)", U("See you Friday.", { event_start: "2026-10-10T02:00:00Z" }).length === 0 && U("See you Saturday.", { event_start: "2026-10-10T02:00:00Z" }).includes("saturday"));
{
  const { splitRecap } = await import("../../src/services/claims.js");
  const live = "Who they are (they said):\n- They are building Co.\n\nWhat is going on right now (they said it, and it is still inside its lifetime):\n- They are weighing an investor meeting. (they said, Oct 5, until Oct 12)\n\nCo's read (inference: orientation only, never state it back as something they told you):\n- They seem to be raising.";
  const sp = splitRecap(live);
  check("a rebuilt recap splits into what they said and what Co read into it", /investor meeting/.test(sp.theySaid) && /building Co/.test(sp.theySaid) && !/raising/.test(sp.theySaid) && /raising/.test(sp.coRead) && !/investor meeting/.test(sp.coRead));
  const facts = (r: { theySaid: string; coRead: string }) => ({ live_things_they_said_about_themselves: r.theySaid || null, recap_of_what_you_know_about_them: r.coRead || null });
  check("a live thing they said backs the event in a companion check-in ('how did the investor meeting go?')", U("How did the investor meeting go?", facts(sp)).length === 0);
  check("what only Co read into it does not back one (('how is the raising going?')", U("How is the raising going?", facts(sp)).length > 0);
  const old = splitRecap("Preparing to pitch investors Friday and working through the ask.");
  check("an old unlabelled prose recap is all background: it backs no event", old.theySaid === "" && U("How did the pitch go?", facts(old)).includes("pitch"));
  check("the companion check-in hands the recap over split", /splitRecap\(recap\.slice\(0, 3000\)\)/.test(fs.readFileSync(new URL("../../src/agent/companionCheckin.ts", import.meta.url), "utf8")));
  check("the event brief carries its date as a date fact (so tonight and the weekday are backed)", /the_event_date: \(await import\("\.\.\/services\/preArrival\.js"\)\)\.localDate\(p\.startAt/.test(fs.readFileSync(new URL("../../src/harness/proactiveRegistry.ts", import.meta.url), "utf8")));
}
P.setProactiveModelForTests(null);
console.log(`proactive specifics: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
