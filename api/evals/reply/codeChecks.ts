// Model-free checks for the Layer 3 gate's deterministic rules. Runs in a
// second, no API calls: npx tsx evals/reply/codeChecks.ts
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
];

let failed = 0;
for (const [draft, expected, label] of cases) {
  const failing = codeChecks(draft, rf, src).filter((c) => !c.pass).map((c) => c.name);
  const ok = expected ? failing.includes(expected) : failing.length === 0;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}: "${draft}" -> ${failing.join(", ") || "(none)"}`);
  }
}
console.log(`codeChecks: ${cases.length - failed}/${cases.length} passed`);
if (failed) process.exitCode = 1;
