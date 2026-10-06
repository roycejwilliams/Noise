// Live check (a few Sonnet calls, well under a dollar): the story text uses
// only what the record gives it. Run: railway run npx tsx evals/companion/storyLive.ts
import "../lib/requireMeter.js";
const { draftCompanionCheckin } = await import("../../src/agent/companionCheckin.js");
const cases = [
  { text: "They were in the middle of: the pitch on Friday. It came through.", then: "I have a big pitch Friday and I'm nervous", now: "the pitch went really well", allowed: /pitch/i },
  { text: "They've been with Co for 30 days.", then: null, now: null, allowed: /30|month/i },
  { text: "They went to Founders Dinner, which Co had sent them.", then: null, now: null, allowed: /founders dinner/i },
];
let bad = 0;
for (const c of cases) {
  for (let i = 0; i < 2; i++) {
    const r = await draftCompanionCheckin("Sam", "", null, null, null, { text: c.text, then: c.then, now: c.now });
    const t = r?.text ?? "(skip)";
    const digits = (t.match(/\d+/g) ?? []).filter((n) => !c.text.includes(n) && !(c.then ?? "").includes(n));
    const invented = /\b(investor|Maya|series|raised|funding)\b/i.test(t) || digits.length > 0;
    const ok = !!r && c.allowed.test(t) && !invented && !/(let me know|i'll keep|i will keep)/i.test(t);
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "BAD "}${t}`);
  }
}
console.log(bad ? `${bad} bad` : "all good");
process.exit(bad ? 1 : 0);
