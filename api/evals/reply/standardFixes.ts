// The product fixes from the free diagnosis of the golden standard set (2026-11-11, 3/11 passing). Layer 1, zero tokens, pure functions:
//   - a decision ask ("best option for me this week?") whose draft names one sent find without its link gets the past-find link guard
//     (agent/findGuards.ts unlinkedPastFinds), and the redraft note names the real tool (shareLink);
//   - "owning a mistake in what Cue sent" counts on a pushback or feedback turn, not only when the mode read says "feedback"
//     (harness/replyGrounding.ts feedbackTurn);
//   - no brevity line on a decision or why-it-fits ask about finds Cue sent (agent/conversationReply.ts lengthLineFor);
//   - "nothing running" stands on the daily search's own idle fact, and "nothing's on my radar" is the honest status (replyGrounding.ts);
//   - the approved wording (Royce, 2026-11-11): DECISION_LINE sends the pick's link again; the vent line receives first, then helps.
//   TZ=UTC node evals/runLayer1.mjs evals/reply/standardFixes.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
const F = await import("../../src/agent/findGuards.js");
const R = await import("../../src/agent/conversationReply.js");
const G = await import("../../src/harness/replyGrounding.js");
import fs from "node:fs";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };

// ---- the pick's link (std-best-option-this-week)
const SENT = [
  { name: "Gradient Reading Club", url: "https://example.test/gradient-reading-club" },
  { name: "Inference Engineers Meetup", url: "https://example.test/inference-engineers" },
  { name: "Foundry Founder Dinner", url: "https://example.test/foundry-founder-dinner" },
];
const PICK = "Gradient Reading Club, Thursday 7pm. Out of the three, it's the one built for people doing the actual work, not pitching.";
const BEST = "What's the best option for me this week?";
const p1 = F.unlinkedPastFinds(PICK, BEST, SENT, []);
check("a decision ask, the draft names one sent find with no link: that find", p1.length === 1 && p1[0].url === SENT[0].url, p1);
check("...not once its link went this turn", F.unlinkedPastFinds(PICK, BEST, SENT, [SENT[0].url]).length === 0);
check("...not when the draft compares two of them by name (no single pick)", F.unlinkedPastFinds("Gradient Reading Club beats the Inference Engineers Meetup for you.", BEST, SENT, []).length === 0);
check("...not on an ordinary question", F.unlinkedPastFinds(PICK, "what time does it start?", SENT, []).length === 0);
check("...not when they said a link was wrong", F.unlinkedPastFinds(PICK, "which one? the link you sent was broken", SENT, []).length === 0);
check("a re-ask still names every unlinked one it names (unchanged)", F.unlinkedPastFinds("Gradient Reading Club and the Inference Engineers Meetup.", "send me the link again", SENT, []).length === 2);
check("DECISION_ASK and FIT_ASK are the same patterns from either module", R.DECISION_ASK === F.DECISION_ASK && R.FIT_ASK === F.FIT_ASK && F.DECISION_ASK.test(BEST));
const note = F.findsRedraftNote("unlinked_sent", SENT.slice(0, 1) as any, []);
check("the past-find redraft note names the real tool (shareLink)", /\bshareLink\b/.test(note) && !/shareLinks/.test(note), note);

// ---- the length line (std-best-option-this-week)
check("no brevity line on a decision ask about sent finds", R.lengthLineFor(BEST, "asking", false, true) === null);
check("no brevity line on a why-it-fits ask about sent finds", R.lengthLineFor("why it fits?", "asking", false, true) === null);
check("the same ask with no finds sent keeps it", R.lengthLineFor(BEST, "asking", false, false) === R.replyLengthLine(BEST) && R.replyLengthLine(BEST) !== null);
check("any other short message keeps it", R.lengthLineFor("what time?", "asking", false, true) === R.replyLengthLine("what time?"));

// ---- the approved wording (exact)
check("DECISION_LINE sends the pick's link again", R.DECISION_LINE.endsWith("what you don't know about it; and send its link again with shareLink before your reply (they asked you to choose, so it isn't a repeat)."));
const replySrc = fs.readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8");
check("the vent line: receive first, then help", replySrc.includes("A vent with a practical ask gets both, in that order: one short line that receives what they feel comes first, then the help.") && !replySrc.includes("A vent with a practical ask gets both: receive what they feel, then actually help."));

// ---- owning a mistake (feedback-cue-mistake)
const conv = "User said: What was the ceramics studio you mentioned last week?\nCo replied: https://emberclaystudio.example/workshops/wheel-intro\nCo replied: Ember Clay Studio in the Mission. Their intro wheel class runs Saturday mornings, four weeks.";
const owns = { text: "That's on me, it shouldn't have gone out dead.", type: "past_action" as const, supported: true, factId: null, quote: "Ember Clay Studio in the Mission. Their intro wheel class runs Saturday mornings, four weeks." };
const asked: string[] = [];
const judge = async (p: string) => { asked.push(p); return '{"onlyOwns": true}'; };
const src = { recentConversation: conv };
const reacting = await G.ownershipReadsFor([owns], { moment: "reacting", pushback: "the link Cue sent doesn't work (404)" }, src, judge);
check("pushback on a 'reacting' turn: the ownership read runs and owns it", reacting.get(owns.text) === true && asked.length === 1);
check("ownsWhatItSent on that turn", G.ownsWhatItSent(owns, { moment: "reacting", pushback: "the link Cue sent doesn't work (404)" }, src, reacting));
check("feedback the read heard counts too", G.feedbackTurn({ moment: "asking", feedbackNoted: true }) && G.feedbackTurn({ moment: "feedback" }));
const none = await G.ownershipReadsFor([owns], { moment: "reacting", pushback: null, feedbackNoted: false }, src, judge);
check("no pushback, no feedback, not the feedback mode: no read, not owned", none.size === 0 && asked.length === 1 && !G.ownsWhatItSent(owns, { moment: "reacting" }, src, reacting));
check("still needs Cue's own sent line", !G.ownsWhatItSent({ ...owns, quote: "the link 404s" }, { moment: "feedback" }, src, reacting));

// ---- "nothing running" (std-old-rec-not-new)
const rf = { facts: [] as any[], instructions: [] as string[] };
G.addFact(rf as any, "unknown", "Cue's daily search isn't looking for anything for them right now. Nothing will be looked for later unless they ask for something a search can find.");
G.addFact(rf as any, "known", G.runningWorkLine([], []));
const idle = rf.facts[0].id;
const claim = (text: string, factId: string) => ({ text, type: "work_status" as const, supported: true, factId, quote: null });
const [radar, running] = G.claimChecks([claim("Nothing's actively on my radar for you right now", idle), claim("I'm searching for engineers every morning", idle)], rf as any, { message: "anything new?", recentConversation: "" } as any);
check("'nothing on my radar' stands on the daily search's idle fact when nothing runs", radar.pass, radar.reason);
check("the idle fact never backs work said as running", !running.pass, running.reason);
const busy = { facts: [] as any[], instructions: [] as string[] };
G.addFact(busy as any, "unknown", "Cue's daily search isn't looking for anything for them right now.");
G.addFact(busy as any, "known", G.runningWorkLine(['Cue is working on task #12 for them: "a venue for their dinner"'], []));
const [busyRadar] = G.claimChecks([claim("Nothing's running for you right now", busy.facts[0].id)], busy as any, { message: "anything new?", recentConversation: "" } as any);
check("...and not 'nothing running' while a task runs", !busyRadar.pass, busyRadar.reason);
// Narrowed in review: "on my radar" is not the running-work status words, so it's no honest-status allowance (check-ins stay status-free).
check("'Nothing's on my radar for you right now' is no honest-status allowance", !G.honestNothingRunning(rf as any, "Nothing's on my radar for you right now.") && G.honestNothingRunning(rf as any, "Nothing's running for you right now."));

// ---- audit round (2026-11-11 evening)
const WHY = "What’s the details and why it fits?";
const DETAILS = "Tonight, 5:30 to 8:30, free, hosted by NVIDIA, SGLang and Modal. Format is drinks and talks.";
const SG = [{ name: "SGLang x NVIDIA Meetup", url: "https://lu.ma/sglang-nvidia-test" }, { name: "Founder Dinner SF", url: "https://lu.ma/founder-dinner-sf-test" }];
check("a why-it-fits ask whose draft names the one find: its link is asked for", F.unlinkedPastFinds(DETAILS, WHY, SG, []).length === 1);
check("...not once it went", F.unlinkedPastFinds(DETAILS, WHY, SG, [SG[0].url]).length === 0);
const S2 = await import("../../src/agent/secondSend.js");
check("'happy to' offers only with an offer verb", S2.offers("Happy to dig into it.") && !S2.offers("Happy to hear it went well.") && !S2.reOffers("Happy to hear that.", ["Want me to look?"]));
// A check-in never reports "nothing running", however true (checkin-nothing).
{
  const ci = { facts: [] as any[], instructions: [] as string[] };
  G.addFact(ci as any, "known", G.runningWorkLine([], []));
  const id = ci.facts[0].id;
  const [onCheckin] = G.claimChecks([claim("nothing on the fire right now", id)], ci as any, { message: "Hey cue, just checking in", recentConversation: "" } as any);
  check("a check-in: 'nothing on the fire right now' fails", !onCheckin.pass, onCheckin.reason);
  const [onSmallTalk] = G.claimChecks([claim("nothing on the fire right now", id)], { ...ci, moment: "small_talk" } as any, { message: "lol same", recentConversation: "" } as any);
  check("small talk too", !onSmallTalk.pass);
  const [asked] = G.claimChecks([claim("Nothing's running for you right now", id)], ci as any, { message: "is anything running for me?", recentConversation: "" } as any);
  check("asked what's running: the true 'nothing running' still passes", asked.pass, asked.reason);
}
// Review of 8471cdb0: the check-in rule cuts only a bare "nothing is running" on a message that is only a check-in and asks nothing.
{
  const T = (claim: string, message: string, moment: string | null = null) => G.checkinStatusTalk(claim, message, moment);
  check("28 still fails: 'nothing on the fire right now' on 'Hey cue, just checking in'", T("nothing on the fire right now", "Hey cue, just checking in"));
  check("...and on small talk", T("nothing on the fire right now", "lol same", "small_talk"));
  check("a check-in that asks: 'Nothing is running for you right now.' passes", !T("Nothing is running for you right now.", "Just checking in, is anything running for me right now?"));
  check("'checking in on the venue search' isn't only a check-in", !T("Nothing back on the venue search yet.", "checking in on the venue search"));
  check("...and 'still on it' is work going on", !T("Nothing back on the venue search yet, still on it.", "Hey cue, just checking in"));
  check("'hey': 'Nothing new on the sponsor search; still digging.' passes", !T("Nothing new on the sponsor search; still digging.", "hey"));
  check("'hey': a bare 'nothing running' still fails", T("Nothing's running for you right now.", "hey"));
  check("an ordinary question with small talk read: not a check-in claim when it asks", !T("Nothing's running right now.", "any update on the dinner?", "small_talk"));
}
// shareFinds never resends a link that just went this turn (std-thin-page): link, caption, nothing twice.
{
  const { createConversationTools } = await import("../../src/agent/conversationTools.js");
  const URL = "https://example.test/founders-supper";
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: any[]) => { lines.push(a.join(" ")); };
  const t = createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: "a founder dinner this month?", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, stubSearch: true, stubEvents: [{ name: "Founders Supper", url: URL, tier: 2, lines: ["Wednesday Oct 21, 7pm, SoMa."] }], sendCoReply: async () => true, facts: { add: () => {}, text: () => `Founders Supper ${URL}` } } as any) as any;
  await t.tools.searchEvents.execute({ what: "founder dinner" }, { toolCallId: "s", messages: [] });
  await t.tools.shareLink.execute({ urls: [URL] }, { toolCallId: "l", messages: [] });
  await t.tools.shareFinds.execute({ items: [{ link: URL, caption: "Founders Supper, Wednesday Oct 21 at 7pm in SoMa." }] }, { toolCallId: "f", messages: [] });
  console.log = log;
  check("the link went once, then its caption", t.state.sentMessages.filter((m: string) => m === URL).length === 1 && t.state.sentMessages[t.state.sentMessages.length - 1] === "Founders Supper, Wednesday Oct 21 at 7pm in SoMa.", t.state.sentMessages);
}

console.log(`reply standard-set fixes: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
