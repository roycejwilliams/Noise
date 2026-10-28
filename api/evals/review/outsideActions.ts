// Outside actions say what actually happened (Royce, 2026-10-27: "after execution, verify against the service and show what actually
// happened; don't present a draft, preview or attempted action as completed"). Layer 1: the real shareLink with a fake send, zero tokens.
//   npx tsx evals/review/outsideActions.ts
import { readFileSync } from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async () => ({ rows: [] });
const { createConversationTools } = await import("../../src/agent/conversationTools.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 300)}` : ""}`); } };
const URL1 = "https://lu.ma/abc123";
const make = (sendOk: boolean) => {
  const facts: { kind: string; text: string }[] = [];
  const t = createConversationTools({
    userId: "00000000-0000-4000-8000-000000000001", phoneNumber: "+10000000000", resolvedContent: "send me that link", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false,
    sendCoReply: async () => sendOk, facts: { add: (kind: string, text: string) => facts.push({ kind, text }), text: () => `the find: ${URL1}` },
  } as any);
  return { tools: t.tools as any, facts };
};
const log = console.log;
console.log = () => {};
console.error = () => {};
const sent = make(true);
const okR = await sent.tools.shareLink.execute({ urls: [URL1], why: "they asked for the link" }, { toolCallId: "t1", messages: [] });
const failedSend = make(false);
const badR = await failedSend.tools.shareLink.execute({ urls: [URL1], why: "they asked for the link" }, { toolCallId: "t2", messages: [] });
console.log = log;
check("shareLink: a link that went is recorded as sent", okR?.ok === true && sent.facts.some((f) => f.kind === "did_this_turn" && f.text.includes(URL1)), { okR, facts: sent.facts });
check("shareLink: a link whose send failed is never recorded as sent, and the tool says so", badR?.ok === false && !failedSend.facts.some((f) => f.kind === "did_this_turn" && /^Sent the link/.test(f.text)), { badR, facts: failedSend.facts });

// The lasting record (co_facts) through the guard the tools already carry (createConversationTools guards them): two links, the
// second one's send fails. Only the one that went is recorded, live and in the log the every-boot backfill rebuilds from.
const inserts: unknown[][] = [];
const decisions: { decision: string; user_id: string; outcome: string; action: string; proposal: any }[] = [];
(pool as any).query = async (sql: string, p: any[] = []) => {
  if (/INSERT INTO harness_decisions/.test(sql)) { decisions.push({ decision: p[1], user_id: p[2], outcome: p[3], action: p[4], proposal: JSON.parse(p[5] ?? "null") }); return { rows: [] }; }
  // The guard's once-per-person and per-day reads, over the rows it logged.
  if (/SELECT 1 FROM harness_decisions/.test(sql)) return { rows: decisions.filter((d) => d.decision === p[0] && d.user_id === p[1] && d.outcome === "act" && String(d.proposal?.input?.personName ?? "").toLowerCase() === p[2]).map(() => ({ "?column?": 1 })) };
  if (/COUNT\(\*\)::int AS n FROM harness_decisions/.test(sql)) return { rows: [{ n: decisions.filter((d) => d.decision === p[0] && d.user_id === p[1] && d.outcome === "act").length }] };
  if (/INSERT INTO co_facts/i.test(sql)) inserts.push(p);
  return { rows: [] };
};
(await import("../../src/services/abilitySwitches.js")).setSwitchesForTest({});
const A = "https://lu.ma/aaa111", B = "https://lu.ma/bbb222";
const partFacts: { kind: string; text: string }[] = [];
const partTools: any = createConversationTools({
  userId: "00000000-0000-4000-8000-000000000001", phoneNumber: "+10000000000", resolvedContent: "send both links", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false,
  sendCoReply: async (o: any) => o.message !== B, facts: { add: (kind: string, text: string) => partFacts.push({ kind, text }), text: () => `finds: ${A} ${B}` },
} as any).tools;
console.log = () => {};
const partR = await partTools.shareLink.execute({ urls: [A, B], why: "they asked for both" }, { toolCallId: "t3", messages: [] });
console.log = log;
const recorded = inserts.map((p) => p.find((x) => typeof x === "string" && /^the link /.test(x))).filter(Boolean);
const shareRow = decisions.find((d) => d.decision === "tool.shareLink");
check("shareLink: when one of two links fails, only the one that went is recorded as sent, now and for later turns", partR?.ok === true && recorded.length === 1 && recorded[0] === `the link ${A}` && partFacts.some((f) => f.kind === "did_this_turn" && f.text.includes(A)) && !partFacts.some((f) => f.kind === "did_this_turn" && f.text.includes(B)), { partR, recorded, partFacts });
check("shareLink: the guard's log names the part that went, so the every-boot backfill can't bring the failed link back", JSON.stringify(shareRow?.proposal?.recordAs) === JSON.stringify({ urls: [A] }), { shareRow });

// requestEventIntro: found and asked, not found, and found but not sent yet all give the one neutral answer, the same fact and the same
// guard receipt, so a second ask for the same name answers the same way whichever it was (review of #284: it once didn't).
const ct = readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
const introAt = ct.indexOf("requestEventIntro: tool({");
const intro = ct.slice(introAt, ct.indexOf("\n    }),\n", introAt) + 8);
const afterLookup = intro.slice(intro.indexOf('if ("error" in resolved)'));
const returns = afterLookup.match(/return [^;]+;/g) ?? [];
check("requestEventIntro: every answer after the lookup is the one neutral answer (no second note, no flag the reply could read)", returns.filter((r) => r === "return neutral();").length === 2 && returns.every((r) => r === "return neutral();" || /couldn't look up their own contact details/.test(r)) && (intro.match(/note: "Tell them that if it's someone/g) ?? []).length === 1 && !/notStarted/.test(ct), { returns });
check("requestEventIntro: a throw retried once, a false never; the internal row says held or failed, never requested", /for \(let attempt = 0; attempt < 2; attempt\+\+\)/.test(intro) && /went === false \?/.test(intro) && /action: failure \? "held_or_failed" : "requested"/.test(intro));
// Not found, through the real tool and its guard, on two turns: the second ask answers exactly like the first, and the record names only the ask.
(await import("../../src/services/theirYes.js")).setYesJudgeForTests(async () => ({ yes: true, why: "stub", read: true }));
inserts.length = 0;
const introFacts: { kind: string; text: string }[] = [];
const answers: unknown[] = [];
for (let turn = 0; turn < 2; turn++) {
  // Each turn builds its tools afresh, as a real reply does; the guard's memory between turns is the decision log.
  const turnTools: any = createConversationTools({
    userId: "00000000-0000-4000-8000-000000000001", phoneNumber: "+10000000000", resolvedContent: "yes please, intro me to Sarah Kim", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false,
    sendCoReply: async () => true, facts: { add: (kind: string, text: string) => introFacts.push({ kind, text }), text: () => "" },
  } as any).tools;
  answers.push(await turnTools.requestEventIntro.execute({ personName: "Sarah Kim", theirYes: "yes please", why: "they asked for the intro" }, { toolCallId: `i${turn}`, messages: [] }).catch((e: any) => ({ threw: String(e?.message ?? e) })));
}
const label = inserts.flat().find((x) => typeof x === "string" && /intro/.test(x));
check("requestEventIntro: a second ask for the same name answers exactly like the first would on the found path (the guard's \"already asked\")", /already/i.test(String((answers[1] as any)?.error ?? "")), { second: answers[1] });
check("requestEventIntro: not found answers the neutral way, with the same fact the found path adds", (answers[0] as any)?.ok === true && /don't say whether you found them/.test((answers[0] as any)?.note ?? "") && introFacts.some((f) => f.kind === "did_this_turn" && /only if that's someone Cue knows/.test(f.text)), { answers, introFacts });
check("requestEventIntro: the lasting record says what they asked, never that an intro was started", typeof label === "string" && /^took their ask for an intro to Sarah/.test(label) && !/started/.test(label), { label });

console.log(`outside actions: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
