// How often does the claim check call a true statement unsupported? (Royce,
// 2026-09-26.) Takes a dump of flagged reply.grounding decisions with their
// context (the thread before, Co's action record, open asks, recent searches)
// and:
//   judge   Opus reads each flagged claim against that context: true, false,
//           or unclear, and for a true one, what would have backed it
//   replay  runs the same drafts through today's claim check with the facts
//           a reply gets now, and reports which true claims are still flagged
//           and which false ones are still caught
//
//   railway run --service co-test --environment dev -- npx tsx evals/grounding/falseFlags.ts <dump.json> judge <judged.json>
//   railway run --service co-test --environment dev -- npx tsx evals/grounding/falseFlags.ts <dump.json> replay <judged.json>
import { GRADER_HEADERS } from "../../src/models.js";
import "../lib/requireMeter.js";
import { readFileSync, writeFileSync } from "fs";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { DateTime } from "luxon";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { parseModelJson } = await import("../../src/services/modelJson.js");
const { capabilitySheet } = await import("../../src/services/capabilities.js");
const { ledgerLine, ledgerLinesFrom } = await import("../../src/services/coFacts.js");
const RG = await import("../../src/harness/replyGrounding.js");
const { GRADER_MODEL } = await import("../texting/grade.js");

type Dump = { id: number; created_at: string; action: string; draft: string; final: string; failed: { name: string; reason: string }[] | null; convo: string[] | null; record: any[] | null; asks: { text: string; kind: string }[] | null; searches: string[] | null }[];
const [dumpPath, mode, judgedPath] = process.argv.slice(2);
const dump: Dump = JSON.parse(readFileSync(dumpPath, "utf8"));
const rows = (d: Dump[number]) => (d.record ?? []).map((r: any) => ({ ...r, at: new Date(r.at) }));
const dayOf = (iso: string) => DateTime.fromISO(iso).setZone("America/Los_Angeles").toISODate()!;
const claimText = (reason: string) => (reason.match(/"([^"]+)"/)?.[1] ?? reason).trim();
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2));
const overlap = (a: string, b: string) => {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
};


function buildFacts(d: Dump[number], old: boolean) {
        const today = DateTime.fromISO(d.created_at).setZone("America/Los_Angeles");
  const rf = RG.baseReplyFacts();
  RG.addFact(rf, "known", `Today is ${today.toFormat("cccc, LLLL d, yyyy")} (Pacific time).`);
  if (old) {
    const asks = (d.asks ?? []).slice(0, 3).map((a) => `"${a.text}"`);
    if (asks.length) RG.addFact(rf, "ongoing", `Co's daily search is looking for: ${asks.join("; ")}. If something real fits, Co may text them about it (at most one text a day). Co can't promise it will find anything, or when.`);
    for (const s of d.searches ?? []) RG.addFact(rf, "did_before", s.replace("[search] ", ""));
  } else {
    for (const f of RG.ongoingFactsFor((d.asks ?? []).map((a) => ({ text: a.text, kind: a.kind === "help" ? "help" : "find" })))) RG.addFact(rf, f.kind, f.text);
    for (const s of d.searches ?? []) RG.addFact(rf, "did_before", RG.searchNoteLine(s, new Date(d.created_at), today.toISODate()!));
  }
  const convo = (d.convo ?? []).join("\n");
  const message = [...(d.convo ?? [])].reverse().find((l) => l.startsWith("User said:"))?.replace(/^User said:\s*/, "") ?? "";
  const coLines = (d.convo ?? []).filter((l) => l.startsWith("Co replied:")).slice(-3).join("\n");
  if (!old) for (const l of ledgerLinesFrom(rows(d), `${message}\n${coLines}`, new Date(d.created_at).getTime())) RG.addFact(rf, "did_before", l);
  return { rf, message, convo };
}

if (mode === "judge") {
  const out: any[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < dump.length) {
        const d = dump[next++];
        const flagged = (d.failed ?? []).filter((f) => f.name.startsWith("claim_") || f.name.includes("claim"));
        if (!flagged.length) continue;
        const today = DateTime.fromISO(d.created_at).setZone("America/Los_Angeles").toFormat("cccc, LLLL d, yyyy");
        const prompt = `You're auditing a fact check on texts from Co (an AI companion) to a member. The check flagged some claims in Co's draft as unsupported. Using ONLY the context below, decide for each flagged claim whether it was actually true.

Today: ${today}

What Co can do:
${capabilitySheet().map((c) => `- ${c}`).join("\n")}

Everything Co had sent or done for them before this, from its record:
${rows(d).map((r: any) => `- ${ledgerLine(r, dayOf(d.created_at))}`).join("\n") || "(nothing)"}

Their open asks: ${(d.asks ?? []).map((a) => `"${a.text}" (${a.kind === "help" ? "kept on file, not searched" : "in the daily search"})`).join("; ") || "(none)"}

Recent searches Co ran: ${(d.searches ?? []).join(" | ") || "(none)"}

The conversation just before (oldest first):
${(d.convo ?? []).join("\n")}

Co's draft:
"${d.draft}"

Flagged claims:
${flagged.map((f, i) => `${i}. ${f.reason}`).join("\n")}

For each: "true" if the context shows it was accurate, "false" if the context shows it wasn't or it's something Co had no basis for, "unclear" if you can't tell. For a true one, say what backs it: "record" (Co's sends/actions), "conversation", "capability", "asks_or_searches", or "other".

Return ONLY JSON: {"verdicts": [{"i": 0, "verdict": "true" | "false" | "unclear", "backedBy": "record" | "conversation" | "capability" | "asks_or_searches" | "other" | null, "why": "one short line"}]}`;
        try {
          const { text } = await generateText({ model: anthropic(GRADER_MODEL), headers: GRADER_HEADERS, maxOutputTokens: 4000, prompt });
          const v = parseModelJson<{ verdicts?: any[] }>(text).verdicts ?? [];
          flagged.forEach((f, i) => {
            const x = v.find((y) => y.i === i) ?? {};
            out.push({ id: d.id, claim: claimText(f.reason), check: f.name, reason: f.reason, verdict: x.verdict ?? "unclear", backedBy: x.backedBy ?? null, why: x.why ?? "" });
          });
        } catch (err: any) {
          console.error(`judge failed on ${d.id}:`, err?.message ?? err);
        }
      }
    }),
  );
  writeFileSync(judgedPath, JSON.stringify(out, null, 2));
  const n = (v: string) => out.filter((o) => o.verdict === v).length;
  console.log(`judged ${out.length} flagged claims: ${n("true")} true (flagged wrongly), ${n("false")} false (flagged rightly), ${n("unclear")} unclear`);
  const by: Record<string, number> = {};
  for (const o of out.filter((o) => o.verdict === "true")) by[o.backedBy ?? "?"] = (by[o.backedBy ?? "?"] ?? 0) + 1;
  console.log(`what would have backed the wrongly flagged ones: ${JSON.stringify(by)}`);
  for (const t of out.filter((o) => o.verdict === "true")) console.log(`  [${t.backedBy}] ${t.claim.slice(0, 90)} | ${t.why.slice(0, 90)}`);
} else if (mode === "timing") {
  // The full check, rewrite and all, on each flagged draft: where the time goes.
  const res: any[] = [];
  const judged = new Map<number, any[]>();
  for (const j of JSON.parse(readFileSync(judgedPath, "utf8"))) judged.set(j.id, [...(judged.get(j.id) ?? []), j]);
  let next = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < dump.length) {
        const d = dump[next++];
        const { rf, message, convo } = buildFacts(d, false);
        const g: any = await RG.groundReply(d.draft, rf, { message, recentConversation: convo }, { record: false }).catch(() => null);
        if (g) {
          // Judged-false claims still in what would be sent.
          const bad = (judged.get(d.id) ?? []).filter((j: any) => j.verdict === "false");
          const sentences = String(g.final).match(/[^.!?\n]+[.!?]*/g) ?? [String(g.final)];
          const left = bad.filter((j: any) => sentences.some((x) => overlap(x, j.claim) >= 0.6)).length;
          const good = (judged.get(d.id) ?? []).filter((j: any) => j.verdict === "true");
          const kept = good.filter((j: any) => sentences.some((x) => overlap(x, j.claim) >= 0.6)).length;
          res.push({ outcome: g.outcome, total: g.latencyMs, first: g.firstCheckMs, ...(g.stages ?? {}), bad: bad.length, left, good: good.length, kept, secondFails: (g.checks ?? []).filter((c: any) => c.name.startsWith("redraft.") && !c.pass).map((c: any) => c.reason) });
        }
      }
    }),
  );
  const rw = res.filter((r) => r.outcome !== "as_drafted");
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  const p90 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)] : 0);
  const col = (k: string) => rw.map((r) => r[k]).filter((x) => typeof x === "number");
  console.log(`${res.length} drafts: ${res.filter((r) => r.outcome === "as_drafted").length} as drafted, ${rw.length} rewritten or cut`);
  console.log(`${process.env.GROUNDING_FULL_RECHECK ? "OLD full re-read" : "NEW changed-only re-read"}: judged-false claims left in what would be sent: ${res.reduce((a, r) => a + r.left, 0)}/${res.reduce((a, r) => a + r.bad, 0)}; judged-true claims kept: ${res.reduce((a, r) => a + r.kept, 0)}/${res.reduce((a, r) => a + r.good, 0)}`);
  if (process.env.SHOW_SECOND_FAILS) for (const r of rw.filter((r) => r.secondFails?.length)) console.log(`  second check failed: ${r.secondFails.join(" | ").slice(0, 200)}`);
  console.log(`rewritten ones, median / p90 seconds: total ${(med(col("total")) / 1000).toFixed(1)} / ${(p90(col("total")) / 1000).toFixed(1)}; first check ${(med(col("first")) / 1000).toFixed(1)}; rewrite ${(med(col("redraftMs")) / 1000).toFixed(1)}; second check ${(med(col("secondCheckMs")) / 1000).toFixed(1)} (${col("secondCheckMs").filter((x) => x < 50).length} skipped as cuts); second rewrite ran ${col("retryMs").length}x, median ${(med(col("retryMs")) / 1000).toFixed(1)}`);
} else if (mode === "replay" || mode === "replay-old") {
  // replay-old: the facts a reply got before 2026-09-26 (every open ask
  // called searched, undated search notes, no action record), for a fair
  // same-noise baseline.
  const old = mode === "replay-old";
  const judged: any[] = JSON.parse(readFileSync(judgedPath, "utf8"));
  const truth = new Map<number, any[]>();
  for (const j of judged) truth.set(j.id, [...(truth.get(j.id) ?? []), j]);
  let trueStill = 0, trueTotal = 0, falseStill = 0, falseTotal = 0, newFlags = 0;
  const started = Date.now();
  const stillWrong: string[] = [];
  const missed: string[] = [];
  let next = 0;
  const ids = dump.filter((d) => truth.has(d.id));
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < ids.length) {
        const d = ids[next++];
        const { rf, message, convo } = buildFacts(d, old);
        const failed = (await RG.claimChecksOnly(d.draft, rf, { message, recentConversation: convo }).catch(() => [])).filter((c: any) => !c.pass).map((c: any) => claimText(c.reason ?? ""));
        for (const j of truth.get(d.id) ?? []) {
          const still = failed.some((f) => overlap(f, j.claim) >= 0.5);
          if (j.verdict === "true") {
            trueTotal++;
            if (still) {
              trueStill++;
              stillWrong.push(`${j.claim.slice(0, 90)} (${j.backedBy})`);
            }
          } else if (j.verdict === "false") {
            falseTotal++;
            if (still) falseStill++;
            else missed.push(`${j.claim.slice(0, 90)}`);
          }
        }
        newFlags += failed.filter((f) => !(truth.get(d.id) ?? []).some((j) => overlap(f, j.claim) >= 0.5)).length;
      }
    }),
  );
  console.log(`${mode}: true claims flagged ${trueStill}/${trueTotal}, false claims caught ${falseStill}/${falseTotal}`);
  console.log(`claims flagged now that weren't before: ${newFlags}`);
  console.log(`replay took ${((Date.now() - started) / 1000).toFixed(0)}s`);
  for (const s of stillWrong) console.log(`  still flagged: ${s}`);
  for (const m of missed) console.log(`  missed: ${m}`);
}
