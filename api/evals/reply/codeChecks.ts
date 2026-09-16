// Model-free checks for the Layer 3 gate's deterministic rules. Runs in a
// second, no API calls: npx tsx evals/reply/codeChecks.ts
import { renderMatchList } from "../../src/services/messageFormat.js";
import { closingReaction } from "../../src/services/conversationClose.js";
import "dotenv/config";
import { addFact, baseReplyFacts, codeChecks } from "../../src/harness/replyGrounding.js";

const rf = baseReplyFacts();
addFact(rf, "scheduled", "A call is scheduled for Tuesday, September 8 at 2:00 PM (America/Los_Angeles).");
addFact(rf, "known", 'Link for "Mixer": https://lu.ma/abc123');
const src = { message: "hey", recentConversation: "Co replied: https://lu.ma/abc123" };

const cases: [string, string | null, string][] = [
  // [draft, expected failing check or null, label]
  ["I'll call you Tuesday at 2pm.", null, "scheduled time matches"],
  ["I'll call you Tuesday at 3pm.", "time_on_file", "wrong time"],
  ["Here's the link again: https://lu.ma/abc123", null, "link on file"],
  ["Here you go: https://lu.ma/zzz999", "link_on_file", "invented link"],
  ["Reach me at (650) 667-0798.", "phone_on_file", "invented phone"],
  ["Calling you now.", "no_call_placed_claim", "calling now"],
  ["I'm still ringing you now too.", "no_call_placed_claim", "ringing"],
  ["Want me to call you right now?", null, "offering a call is fine"],
  ["This is text, I can't actually call.", "no_capability_denial", "capability denial"],
  ["I'll make sure we don't call you before 5.", null, "not a denial"],
  ["I'll let you know as soon as I hear back.", "no_followup_promise", "follow-up promise"],
  ["Waiting to hear back, will let you know.", "no_followup_promise", "follow-up promise without I"],
  ["I can keep an eye out for one.", "no_followup_promise", "keep an eye out"],
  ["Let me know if anything changes.", null, "their follow-up, not Co's"],
  ["Will do.", null, "bare will do"],
  ["If a good one turns up in Oakland I'll send it your way.", "no_followup_promise", "send it your way"],
  ["I'll pass it along if I hear anything.", "no_followup_promise", "pass it along"],
  ["Send it my way whenever.", null, "their send, not Co's"],
  ["Will do. If a good Oakland running group turns up, I'll text you.", "no_followup_promise", "conditional promise first"],
  ["When you get there, I'll text you the address?", "no_followup_promise", "when-clause promise"],
  ["If you want, I can look now.", null, "offer to act now, not later"],
  // From Royce's 2026-09-15 thread: no open search behind these.
  ["I'll keep watching for one that fits a Series A team and text you the second something real shows up.", "no_followup_promise", "keep watching, no open ask"],
  ["Got it. I'll keep my eyes open for people worth putting you in front of.", "no_followup_promise", "keep my eyes open, no open ask"],
  ["No pressure if the timing doesn't work, want me to keep an eye out for the next one?", null, "offer (saveAsk makes a yes real)"],
  ["On it, I'll ask Devon and let you know what he says.", "no_followup_promise", "promise after another verb"],
  ["I'll dig into it and get back to you.", "no_followup_promise", "dig in and get back"],
];

// With an open ask the daily search really runs: keeping looking is true,
// a timing commitment still isn't.
const rfOngoing = baseReplyFacts();
addFact(rfOngoing, "ongoing", 'Co\'s daily search is looking for: "friends to hang out with in SF". If something real fits, Co may text them about it (at most one text a day).');
const ongoingCases: [string, string | null, string][] = [
  ["Nothing real yet, but I'll keep looking and text you if something fits.", null, "keep looking with open ask"],
  ["I'll keep an eye out for people worth meeting.", null, "keep an eye out with open ask"],
  ["I'll keep looking and text you the second something shows up.", "no_followup_promise", "timing commitment even with open ask"],
  ["I'll keep looking and get back to you tomorrow.", "no_followup_promise", "tomorrow commitment"],
];

// When a thread is over: react instead of replying (services/conversationClose.ts).
const closingCases: [string, string | null][] = [
  ["Cool", "like"],
  ["cool thanks!", "like"],
  ["Nice thanks \u{1F64F}\u{1F3FE}", "like"],
  ["\u{1F44D}", "like"],
  ["ok cool thanks so much", "like"],
  ["got it", "like"],
  ["sounds good", "like"],
  ["perfect", "love"],
  ["lol", "laugh"],
  ["haha amazing", null],
  ["Cool, can you send it again?", null],
  ["thanks, what time does it start", null],
  ["Which one?", null],
  ["cool i'll check it out and let you know what i think", null],
  ["Yeah", null],
  ["ok call me now", null],
  ["Tell me more", null],
  ["no", null],
];

// How several real things read in one message (services/messageFormat.ts).
const oneItem = renderMatchList(["ERA Winter 2027 is NYC, $150K on a SAFE, applications open now."]);
const twoItems = renderMatchList(["ERA Winter 2027, NYC, $150K SAFE, open now.", "16vc, 20-25 companies, $200K, pre-seed/seed."]);
const threeItems = renderMatchList(["a", "b", "c"]);
const formatCases: [boolean, string][] = [
  [oneItem === "ERA Winter 2027 is NYC, $150K on a SAFE, applications open now.", "one item is the sentence itself, no bullet"],
  [!oneItem.includes("\u2022"), "one item has no bullet"],
  [twoItems.startsWith("Two that fit:\n\n"), "two items get the lead-in"],
  [twoItems.split("\u2022").length === 3, "two items get two bullets"],
  [twoItems.includes("open now.\n\n\u2022"), "bullets are separated by a blank line"],
  [threeItems.startsWith("3 that fit:"), "three items count in the lead-in"],
  [!twoItems.includes("http"), "links are never in the list message"],
];

let failed = 0;
for (const [ok, label] of formatCases) {
  if (!ok) {
    failed++;
    console.log(`FAIL format: ${label}`);
  }
}

for (const [message, expected] of closingCases) {
  const got = closingReaction(message);
  if (got !== expected) {
    failed++;
    console.log(`FAIL closing "${message}" -> ${got ?? "(reply)"} , expected ${expected ?? "(reply)"}`);
  }
}

for (const [draft, expected, label] of cases) {
  const failing = codeChecks(draft, rf, src).filter((c) => !c.pass).map((c) => c.name);
  const ok = expected ? failing.includes(expected) : failing.length === 0;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}: "${draft}" -> ${failing.join(", ") || "(none)"}`);
  }
}
for (const [draft, expected, label] of ongoingCases) {
  const failing = codeChecks(draft, rfOngoing, src).filter((c) => !c.pass).map((c) => c.name);
  const ok = expected ? failing.includes(expected) : failing.length === 0;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}: "${draft}" -> ${failing.join(", ") || "(none)"}`);
  }
}
const total = cases.length + ongoingCases.length + closingCases.length + formatCases.length;
console.log(`codeChecks: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
