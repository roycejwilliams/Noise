// How long Co's own pick of what to text first takes (harness/proactive.ts
// choosePick), and how often it falls back to plain priority.
//
//   npx tsx evals/proactive/pickTiming.ts [runs]
import "../lib/requireMeter.js";
const { choosePick } = await import("../../src/harness/proactive.js");
const now = new Date();
const c = (id: string, type: string, summary: string, priority: number) => ({ id, type, summary, priority, dueAt: now, createdAt: now, expiresAt: null, targetKey: `${type}:${id}`, payload: {}, attempts: 0 }) as any;
const eligible = [
  c("1", "event_offer", "Offer AgentFi demo day at The Avalon, Oct 7, founders and sponsors", 60),
  c("2", "debrief", "Ask how Mahjong After Dark went on Sep 24", 90),
  c("3", "window_followup", "Ask how Oct 10 went for them (they asked Cue to look for sponsors)", 35),
  c("4", "companion", "Ask how the sponsor deck for the Oct 10 event is coming along (they said it was stressing them out)", 10),
];
const convo = Array.from({ length: 30 }, (_, i) => (i % 2 ? `Co replied: Here's what I found for this weekend, a couple of founder dinners in SF and one in Oakland ${i}.` : `User said: can you find me events with sponsors for my event on the 10th ${i}`)).join("\n");
const runs = Number(process.argv[2] ?? 5);
const times: number[] = [];
let co = 0;
for (let i = 0; i < runs; i++) {
  const t = Date.now();
  const r = await choosePick(eligible, { recentConversation: convo, feeling: "A bit stressed about the event on the 10th.", taste: "Liked founder dinners." });
  times.push(Date.now() - t);
  if (r.source === "co") co++;
  console.log(`${Date.now() - t}ms ${r.source} -> ${r.pick?.type}: ${r.reason.slice(0, 100)}`);
}
times.sort((a, b) => a - b);
console.log(`Cue picked ${co}/${runs}; median ${times[Math.floor(runs / 2)]}ms, max ${times[runs - 1]}ms`);
