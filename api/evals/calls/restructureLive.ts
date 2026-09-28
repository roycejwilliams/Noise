// Live check for calls on the shared picture (2026-09-28). Runs the real
// buildCallKnowledge against Royce's co-test rows (served from a JSON dump
// pulled via psql, since local runs can't reach the database), and the merged
// after-call read against the old separate extraction on one real call.
// Writes nothing.
//
//   npx tsx evals/calls/restructureLive.ts <dump.json> <call.json>
import { readFileSync } from "fs";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const [dumpPath, callPath] = process.argv.slice(2);
const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
const call = JSON.parse(readFileSync(callPath, "utf8"));

// Serve the member's own rows; anything else reads as empty.
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async (sql: string) => {
  const s = String(sql);
  if (/FROM revealed_offers/.test(s)) return { rows: dump.revealed };
  if (/FROM proactive_candidates/.test(s) && /event_offer/.test(s)) return { rows: dump.offers };
  if (/memory_type = 'co_lesson'/.test(s)) return { rows: dump.lessons.map((c: string) => ({ content: c })) };
  if (/FROM member_threads/.test(s)) return { rows: dump.threads };
  if (/FROM ask_checkins/.test(s)) return { rows: dump.asks.map((a: any) => ({ ...a, kind: "find" })) };
  if (/FROM co_profiles/.test(s)) return { rows: dump.profile ? [dump.profile] : [] };
  return { rows: [] };
};

const { buildCallKnowledge } = await import("../../src/services/callContext.js");
const k = await buildCallKnowledge("3e0f6345-da84-47c2-9fc6-06b667a32857");
console.log("=== call opens with (first 1400 chars) ===");
console.log(k.summary.slice(0, 1400));
console.log(`\n[has Grok time: ${/Grok Bot[\s\S]{0,200}5:00 PM/.test(k.summary)}] [has daytonaio not on file: ${/daytonaio[\s\S]{0,160}no start time/i.test(k.summary)}] [length ${k.summary.length}]`);

// The merged after-call read vs the old separate extraction, same call.
const { generateText } = await import("ai");
const { anthropic } = await import("@ai-sdk/anthropic");
const { callLearningPrompt, callLessonsFrom } = await import("../../src/services/callLearning.js");
const { parseTurnLearning } = await import("../../src/services/turnLearning.js");
const { extractPsychographicProfile } = await import("../../src/services/profileExtraction.js");
const { PROFILE_JUDGMENT_MODEL } = await import("../../src/harness/profileWrite.js");
const openAsks = dump.asks.map((a: any) => ({ id: String(a.ask_id), text: String(a.ask_text) }));
const onFile = dump.profile;

const run = async (transcript: string) => {
  const { text } = await generateText({ model: anthropic(PROFILE_JUDGMENT_MODEL), maxOutputTokens: 3000, prompt: callLearningPrompt({ transcript, today: "2026-09-22", onFile, openAsks }) });
  let raw: unknown = null;
  try {
    raw = JSON.parse(text.replace(/```(?:json)?/g, "").trim());
  } catch {}
  return { learned: parseTurnLearning(text), lessons: callLessonsFrom(raw, transcript) };
};

const merged = await run(call.content);
const old = await extractPsychographicProfile(call.content);
console.log("\n=== real call", call.created_at, "===");
for (const f of ["goals", "blockers", "activity_preferences", "life_chapters", "city", "emotional_state", "long_term_direction", "availability_pattern"]) {
  console.log(`${f}\n  old:    ${JSON.stringify((old.extracted as any)[f] ?? null)}\n  merged: ${JSON.stringify((merged.learned?.profile as any)?.[f] ?? null)}`);
}
console.log(`merged resolved: ${JSON.stringify(merged.learned?.resolved)}\nmerged corrections: ${JSON.stringify(merged.learned?.corrections)}\nmerged cadence: ${merged.learned?.cadence}\nmerged planned_event: ${JSON.stringify(merged.learned?.planned_event)}\nmerged lessons: ${JSON.stringify(merged.lessons)}`);

// Pushback on a call becomes a lesson.
const pushback = `assistant: Both are the same night, so it's one or the other. And once you lock Oct 10, sponsors will say yes.
user: This has nothing to do with Oct 10th, I was just asking whether the two Tuesday events overlap.
assistant: Got it, my mistake.
user: Yeah just answer what I ask about the times.`;
const pb = await run(pushback);
console.log(`\n=== pushback call ===\nlessons: ${JSON.stringify(pb.lessons)}`);
process.exit(0);
