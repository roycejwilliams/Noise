// Live check of the snapshot rebuild with open threads folded in
// (harness/personSnapshot.ts snapshotAndThreadsPrompt), on a psql export of
// one member's recent words, asks, previous picture and open threads. Runs
// the model call and the thread gate only; writes nothing.
//
//   npx tsx evals/turnLearning/snapshotLive.ts <file>
import "../lib/requireMeter.js";
import { readFileSync } from "fs";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
const { snapshotPrompt, parseSnapshot, snapshotAndThreadsPrompt, renderSnapshot } = await import("../../src/harness/personSnapshot.js");
const { threadsPrompt, gateThreadChanges } = await import("../../src/harness/memberThreads.js");
const { MODELS } = await import("../../src/models.js");
const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
const input = { firstName: "Royce", previous: d.previous, recentStatements: d.statements ?? [], openAsks: d.asks ?? [], outcomes: [] };
const onFile = (d.threads ?? []).map((t: any) => ({ ...t, openedAt: new Date(t.openedAt).toISOString(), lastTouchedAt: new Date(t.lastTouchedAt).toISOString() }));
const lines = input.recentStatements.slice(-80);
const r = await generateText({
  model: anthropic(MODELS.sonnet),
  providerOptions: { anthropic: { effort: "low" } },
  prompt: snapshotAndThreadsPrompt(snapshotPrompt(input), threadsPrompt("Royce", onFile, lines)),
});
let both: any = null;
try { both = JSON.parse(r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1)); } catch {}
const snap = both?.snapshot ? parseSnapshot(JSON.stringify(both.snapshot)) : null;
console.log("snapshot parsed:", !!snap);
console.log(renderSnapshot(snap));
console.log("\nprevious:\n" + renderSnapshot(d.previous));
const g = gateThreadChanges(both?.threads?.open ?? [], both?.threads?.close ?? [], onFile, lines, "America/Los_Angeles");
console.log("\nthreads proposed:", JSON.stringify(both?.threads ?? null).slice(0, 500));
console.log("thread gate: opened", g.opened.map((o) => o.text), "closed", g.closed.map((c) => c.id));
console.log(`tokens in ${r.usage?.inputTokens}, out ${r.usage?.outputTokens}`);
