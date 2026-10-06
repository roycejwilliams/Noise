// Live check of the guided redraft (harness/proactive.ts draftAgain): the
// 09-23 companion check-ins that opened "Hey Jacqueline," and never went out.
// Real model, no DB, nothing sent.
//
//   npx tsx evals/proactive/redraft.ts [runs]
import "../lib/requireMeter.js";
const { draftAgain, checkDraft } = await import("../../src/harness/proactive.js");
const { draftCompanionCheckin } = await import("../../src/agent/companionCheckin.js");
const recap = "Joined Co recently. Gave her name and email. Co asked what she's into and what keeps her busy; she hasn't said yet.";
const failed = [
  "Hey Jacqueline, still meaning to get a real sense of you, what's been keeping you busy these days?",
  "Hey Jacqueline, still curious what you're into these days, work, hobbies, what's keeping you busy lately. Whenever you feel like sharing, I'm here.",
];
const runs = Number(process.argv[2] ?? 3);
let fresh = 0, freshOk = 0, fixedOk = 0, total = 0;
for (let r = 0; r < runs; r++) {
  const d = await draftCompanionCheckin("Jacqueline", recap);
  if (d) { fresh++; if (checkDraft(d.text, d.rules).every((c) => c.pass)) freshOk++; else console.log("fresh draft failed:", d.text); }
  for (const f of failed) {
    total++;
    const again = await draftAgain({ draft: f, failed: "draft_no_greeting: opens with a greeting" }, () => draftCompanionCheckin("Jacqueline", recap));
    const ok = !!again && checkDraft(again.text, again.rules).every((c) => c.pass);
    if (ok) fixedOk++;
    console.log(ok ? "fixed:" : "STILL FAILS:", again?.text ?? "(skip)");
  }
}
console.log(`first drafts passing: ${freshOk}/${fresh}; redrafts fixed: ${fixedOk}/${total}`);
