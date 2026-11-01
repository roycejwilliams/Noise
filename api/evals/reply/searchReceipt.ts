// A search Cue ran in this turn backs saying what it just did, never that work is running (golden feedback-cue-mistake, 2026-11-01:
// "I looked just now…" citing the search receipt was cut as work status, and "Nothing's running on that right now." was put in front).
//   TZ=UTC node evals/runLayer1.mjs evals/reply/searchReceipt.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const G = await import("../../src/harness/replyGrounding.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, JSON.stringify(detail ?? "").slice(0, 400)); } };

const turn = () => {
  const rf = G.baseReplyFacts();
  G.addFact(rf, "known", G.runningWorkLine([], []));
  G.addFact(rf, "did_this_turn", 'Searched the web just now ("Ember Clay Studio wheel class"): nothing held up on its own page.');
  return rf;
};
const receiptId = (rf: any) => rf.facts.find((f: any) => G.SEARCHED_THIS_TURN.test(f.text)).id;
const src = { message: "that link is dead", recentConversation: "" };
const claim = (text: string, factId: string) => ({ text, type: "work_status" as const, supported: true, factId, quote: null });

{
  const rf = turn();
  const [done] = G.claimChecks([claim("I looked just now for a current page and didn't find one that works.", receiptId(rf))], rf, src);
  check("a search done this turn, said as done, is backed by its receipt", done.pass, done.reason);
  const [still] = G.claimChecks([claim("I'm still searching for a working page.", receiptId(rf))], rf, src);
  check("'still searching' with only this turn's receipt is still cut: nothing is running", !still.pass && /nothing is running/.test(still.reason ?? ""), still.reason);
  const [keep] = G.claimChecks([claim("I'll keep looking in the background.", receiptId(rf))], rf, src);
  check("…and so is 'I'll keep looking'", !keep.pass);
}
{
  const rf = turn();
  const failedWork = [{ name: "claim_work_status", pass: false, reason: 'work_status: "I\'m still searching" (nothing is running)' }];
  const out = await G.withNothingRunningLine("Want me to look again?", failedWork, rf, async () => true);
  check("after a search this turn, 'Nothing's running on that right now' is never put in front", out === "Want me to look again?", out);
  check("…and the nothing-running path doesn't apply", !G.nothingRunningLineApplies({ draft: "x", cut: "x", failed: failedWork, rf }));
  const plain = G.baseReplyFacts();
  G.addFact(plain, "known", G.runningWorkLine([], []));
  check("without a search this turn the honest line still goes in front", /^Nothing's running on that right now\./.test(await G.withNothingRunningLine("Want me to look again?", failedWork, plain, async () => true)));
}
check("the receipt shape is the one the tools write (agent/loopTools.ts)", G.SEARCHED_THIS_TURN.test('Searched the web just now ("a"): 2 held up on their own pages.') && G.SEARCHED_THIS_TURN.test('Looked up events for "jazz", Friday just now: nothing came back.') && !G.SEARCHED_THIS_TURN.test("They said they searched the web just now."));

console.log(`search receipt: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
