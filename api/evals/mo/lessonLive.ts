// Without a separate moment read, Mo still keeps a lesson when corrected (noteLesson). Dry run.
import "../lib/requireMeter.js";
process.env.SENDBLUE_API_API_KEY ||= "x"; process.env.SENDBLUE_API_API_SECRET ||= "x";
const { runMoTeamTurn } = await import("../../src/mo/teamAgent.js");
const recent = "Mo replied: 6 people are waiting on your yes, 0 in progress, 0 joined so far.\nUser said: what's their names and profession [to Mo]\nMo replied: It's Mo, I extend invitations to Co.";
let ok = 0;
for (const text of ["No, I meant the people you found, not you", "that's not what I asked, I wanted the people in the queue"]) {
  const r = await runMoTeamTurn({ userId: "00000000-0000-0000-0000-000000000000", approverFirst: "Royce", text, pending: null, coSpoke: false, dryRun: true, awareness: { recent, topic: null, pushback: null, lessons: [], repliedTo: null, handedOff: false, needsIntro: false } as any });
  const hit = r.tools.includes("noteLesson");
  if (hit) ok++;
  console.log(`${hit ? "ok  " : "MISS"} ${JSON.stringify(text)} -> tools [${r.tools.join(",")}] | ${String(r.reply).slice(0, 150)}`);
}
console.log(`lessons kept: ${ok}/2`);
