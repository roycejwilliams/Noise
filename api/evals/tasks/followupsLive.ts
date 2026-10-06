// Co deciding a follow-up's timing, dry (nothing written or sent). ~$0.05.
//   railway run npx tsx evals/tasks/followupsLive.ts
import "../lib/requireMeter.js";
import "dotenv/config";
process.env.SENDBLUE_API_API_KEY ||= "x";
process.env.SENDBLUE_API_API_SECRET ||= "x";
const F = await import("../../src/services/followUps.js");
const now = new Date("2026-10-05T18:00:00Z");
const task = (summary: string, type: string): any => ({ id: 1, userId: "u", goal: summary, wakes: 1, createdAt: now.toISOString(), followup: { type, summary } });
const cases: [string, any, string, string, string][] = [
  ["already told how it went", task("Ask how the weekend went (they asked about events this weekend)", "window_followup"), "User said: anything fun this weekend?\nCo replied: Grok Bot x Notion Saturday.\nUser said: went to the Grok thing Saturday, it was great, met two founders", "", "skip"],
  ["mid-conversation right now", task("Ask how the investor pitch ask went", "companion"), "User said: ok so about the block party venue, can you look at indoor spots\nCo replied: On it.\nUser said: also need a DJ", "- 2026-10-05T17:50 task_update\n- 2026-10-05T16:00 event_offer", "later"],
  ["quiet, and it happened", task("Ask how the investor pitch ask went (advice given 4 days ago)", "companion"), "User said: I am pitching investors Friday and I keep freezing on the ask\nCo replied: Write the ask as one sentence, say it early, then stop talking.\nUser said: ok will try", "", "now"],
];
let right = 0;
for (const [label, t, recent, sends, want] of cases) {
  let did = "";
  const r = await F.runFollowUpTurnWith(t, { firstName: "Sam", recent, recentSends: sends, now: () => now, checkInNow: async () => { did = "now"; return true; }, later: async (h) => { did = `later ${h}h`; }, skip: async () => { did = "skip"; } });
  const ok = r.action === want;
  if (ok) right++;
  console.log(`${ok ? "ok  " : "BAD "} ${label}: ${did} — ${r.why}`);
}
console.log(`follow-up decisions: ${right}/${cases.length} as expected`);
process.exit(0);
