// Ask kinds (2026-10-08): Co's own promises and deliverables, statuses and
// partnership statements are never "find" asks, so the sweep never spends its
// one X search on them. A narrow code guard for Co's own commitments; the rest
// is the classifier's call, from its instructions. Model-free (only the guard
// is called; it answers before any model):
//   npx tsx evals/asks/kind.ts
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const K = await import("../../src/services/askKind.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && detail ? `\n     ${detail}` : ""}`);
};
const ak = fs.readFileSync(new URL("../../src/services/askKind.ts", import.meta.url), "utf8");

// The real ones that wasted X searches (co-test, 2026-10).
for (const t of [
  "draft and text a plan on Cue's post-event presence",
  "plan will be delivered once ready",
  "I'll send the outline tonight",
  "Cue will follow up with the sponsor list",
  "the deck to be shared after the call",
  "Write up a plan for the November dinner",
]) check(`Cue's own promise or deliverable: "${t}"`, K.isCoCommitment(t));

// Real asks to find stay asks to find.
for (const t of [
  "founder dinners in SF this month",
  "find a running club to be ready for the marathon",
  "accelerators taking applications for a pre-seed AI startup",
  "people I can send my resume to at climate startups",
  "a writing group, I want to write a novel",
  "prepare for a hackathon, find one in October",
  "events where we can follow the latest in AI",
  "make friends who like hiking",
]) check(`still a thing to find: "${t}"`, !K.isCoCommitment(t));

check("empty text is not a commitment", !K.isCoCommitment("") && !K.isCoCommitment("   "));

// The guard answers before any model call.
check("a Cue commitment is 'help' without asking the model", (await K.classifyAsk("plan will be delivered once ready")) === "help");
check("anything else still goes to the model", /if \(isCoCommitment\(text\)\) return "help";\s*try \{\s*const \{ text: out \} = await Promise\.race\(\[\s*generateText\(/.test(ak) && /prompt: askKindPrompt\(text\)/.test(ak));

// The classifier's instructions.
const p = K.askKindPrompt("Offering to partner with Sequin AI on a November event");
check("the prompt carries the ask", p.includes("Offering to partner with Sequin AI"));
check("the prompt says Cue's own deliverables and statuses are help", /something Cue said it would do or deliver/.test(p) && /will be delivered once ready/.test(p));
check("the prompt says statements of what they're doing (a partnership) are help", /offering to partner with a company/.test(p) && /nothing in it to go and find/.test(p));
check("the prompt keeps find for events, people, programs", /an event, a group or community/.test(p) && /a program or an opportunity/.test(p));
check("the prompt has no em dash or exclamation point", !/[—–!]/.test(p));

// Royce, 2026-10-13: an open find ask that reads as Co's own work keeps being searched (the status-check lane): the morning job no
// longer switches it to help without a word. Only a new ask is classified at birth.
{
  const job = ak.slice(ak.indexOf("export async function classifyOpenAsks"), ak.indexOf("export async function closeAsk"));
  check("open find asks that read as Cue's own work are left searched (no silent switch)", !/isCoCommitment\(/.test(job) && !/kind: "help"/.test(job));
  const writes: string[] = [];
  const db = { query: async (sql: string) => { if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) writes.push(sql.slice(0, 60)); return /kind = 'find' AND intent IS DISTINCT/.test(sql) ? { rows: [{ id: "a1", ask_text: "draft the launch plan for the Sequin party", kind: "find", intent: "question" }] } : { rows: [] as any[], rowCount: 0 }; } };
  await K.classifyOpenAsks(25, { db, classify: async () => "help" });
  check("the morning job writes nothing for an already-classified Co-work ask", writes.length === 0, writes.join(" | "));
}
// A lookout's kind is never changed by the kind job (lane moves, 2026-10-13): every kind write goes through laneMoves.ts setAskKind.
check("the kind job never writes ask_checkins kind itself", !/UPDATE ask_checkins SET kind/.test(ak) && /r\.intent === "lookout"/.test(ak));
check("re-marking never closes or reopens an ask", !/resolved_at = (NOW|NULL)/.test(ak.slice(ak.indexOf("export async function classifyOpenAsks"), ak.indexOf("export async function closeAsk"))));

console.log(`ask kinds: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
