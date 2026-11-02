// Every tool outcome leaves a receipt (2026-11-02 helper audit, PR 2). Before: a tool that threw left no NOT DONE fact, no decision
// row and no ledger row (agent/toolGuard.ts had no try/catch around run), so nothing stopped a reply from saying it was done; and
// refusals were logged without their reason (shareFinds: error "" with the reason in refused; saveAsk: no reason at all).
// Zero tokens: the database is a fake that keeps what's written; the claim check is the pure claimChecks with a fixed claim.
//   1. a tool that throws: a NOT DONE receipt for the reply, a not_done decision row with what was thrown, a not_done ledger row, and
//      the same error thrown on to the SDK (what the model reads is unchanged)
//   2. the claim check cuts "done" after a throw, whether the claim cites nothing or the NOT DONE receipt
//   3. the same request after a throw is recorded once: not run again, not logged again, one receipt
//   4. refusals are logged with their reason: shareFinds' refused items, saveAsk's kept reason, an error as before
//   npx tsx evals/capabilities/throwReceipts.ts
import { z } from "zod";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };

// The fake database: decision rows and ledger rows kept; everything else reads empty.
const { default: pool } = await import("../../src/db/db.js");
const decisions: { decision: string; action: string; outcome: string; proposal: any }[] = [];
const ledger: { relation: string; receipt: string }[] = [];
(pool as any).query = async (sql: string, p: any[] = []) => {
  const flat = sql.replace(/\s+/g, " ");
  if (/INSERT INTO harness_decisions/.test(flat)) {
    decisions.push({ decision: p[1], outcome: p[3], action: p[4], proposal: p[5] ? JSON.parse(p[5]) : null });
    return { rows: [{ id: String(decisions.length), created_at: new Date() }] };
  }
  if (/INSERT INTO co_facts/i.test(flat) && String(p[3]).startsWith("L|")) { ledger.push({ relation: String(p[1]), receipt: JSON.parse(String(p[7] ?? "{}")).receipt }); return { rows: [] }; }
  return { rows: [] };
};
(await import("../../src/services/abilitySwitches.js")).setSwitchesForTest({});
const { guardTools, refusalReason, requestKey, withReason } = await import("../../src/agent/toolGuard.js");
const G = await import("../../src/harness/replyGrounding.js");
const settle = async (n: number) => { for (let i = 0; i < 200 && (decisions.length < n); i++) await new Promise((r) => setTimeout(r, 5)); await new Promise((r) => setTimeout(r, 30)); };
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };

// A turn: the guard over stand-in tools, its receipts going into the reply's facts the way conversationReply.ts wires them.
const turn = (tools: Record<string, (input: any) => Promise<any>>) => {
  const rf = G.createReplyFacts();
  const runs: string[] = [];
  const wrapped: any = guardTools(
    Object.fromEntries(Object.entries(tools).map(([name, fn]) => [name, { execute: async (input: any) => (runs.push(name), fn(input)), inputSchema: z.object({ to: z.string().optional(), subject: z.string().optional(), what: z.string().optional() }) }])),
    { userId: "u-1", resolvedContent: "can you draft the email to the venue", dryRun: false, notDone: (w) => G.addFact(rf, "not_done", w) },
  );
  return { rf, runs, tools: wrapped };
};
const boom = new Error("Resend 502: upstream unavailable");

// ------------------------------------------------------------ 1. a thrown tool leaves its receipt
decisions.length = 0; ledger.length = 0;
const t1 = turn({ draftEmail: async () => { throw boom; } });
let thrown: unknown = null;
await quietly(() => t1.tools.draftEmail.execute({ to: "events@venue.example", subject: "Dinner for 12", why: "they asked" }, {}).catch((e: unknown) => { thrown = e; }));
await settle(1);
check("the error is thrown on unchanged, so the model reads the same tool error it always did", thrown === boom);
const nd = t1.rf.facts.filter((f) => f.kind === "not_done");
check("the reply has a NOT DONE receipt for it", nd.length === 1 && /^draftEmail didn't go through: it failed with an error\.$/.test(nd[0].text), t1.rf.facts);
check("…and nothing says it was done", !t1.rf.facts.some((f) => f.kind === "did_this_turn"));
check("the decision row says not_done, with what was thrown", decisions.length === 1 && decisions[0].decision === "tool.draftEmail" && decisions[0].outcome === "skip" && decisions[0].action === "not_done" && decisions[0].proposal?.threw === true && /^threw: Resend 502/.test(decisions[0].proposal?.error ?? ""), decisions);
await settle(1);
check("…and the action ledger has a not_done row for it", ledger.length === 1 && ledger[0].relation === "not_done" && ledger[0].receipt === "not_done", ledger);

// ------------------------------------------------------------ 2. the claim check cuts "done" after a throw
{
  const src = { message: "can you draft the email to the venue", recentConversation: "User said: can you draft the email to the venue" };
  const claim = (factId: string | null): any => ({ text: "Done, the draft to the venue is in your texts.", type: "past_action", supported: true, factId, quote: null });
  const [citesNothing] = G.claimChecks([claim(null)], t1.rf, src);
  const [citesReceipt] = G.claimChecks([claim(nd[0].id)], t1.rf, src);
  check("a 'done' claim after a throw, citing nothing: cut", citesNothing.pass === false && /has to come from a fact/.test(citesNothing.reason), citesNothing);
  check("…citing the NOT DONE receipt: cut as tried and not done", citesReceipt.pass === false && /did NOT happen/.test(citesReceipt.reason), citesReceipt);
  // The control: the same claim when the tool went through and left its receipt.
  const ok = turn({ draftEmail: async () => ({ ok: true }) });
  await quietly(() => ok.tools.draftEmail.execute({ to: "events@venue.example", subject: "Dinner for 12" }, {}));
  G.addFact(ok.rf, "did_this_turn", 'Sent them a draft to the venue: "Dinner for 12"');
  const [backed] = G.claimChecks([claim(ok.rf.facts.find((f) => f.kind === "did_this_turn")!.id)], ok.rf, src);
  check("control: with a real receipt the same claim stands", backed.pass === true, backed);
  check("the receipts the claim check reads as done never include the throw", !G.receiptsForCheck(t1.rf).includes("draftEmail"));
}

// ------------------------------------------------------------ 3. the same request after a throw is recorded once
{
  decisions.length = 0; ledger.length = 0;
  const t = turn({ draftEmail: async () => { throw boom; } });
  const input = { to: "events@venue.example", subject: "Dinner for 12" };
  const errs: unknown[] = [];
  await quietly(async () => {
    await t.tools.draftEmail.execute({ ...input, why: "they asked" }, {}).catch((e: unknown) => errs.push(e));
    // The same request, with a different why and its keys in another order.
    await t.tools.draftEmail.execute({ subject: "Dinner for 12", to: "events@venue.example", why: "trying again" }, {}).catch((e: unknown) => errs.push(e));
  });
  await settle(1);
  check("the same request again isn't run again", t.runs.length === 1, t.runs);
  check("…gets the same error", errs.length === 2 && errs[0] === boom && errs[1] === boom);
  check("…and is recorded once: one decision row, one ledger row, one NOT DONE receipt", decisions.length === 1 && ledger.length === 1 && t.rf.facts.filter((f) => f.kind === "not_done").length === 1, { decisions, ledger, facts: t.rf.facts });
  check("request keys ignore Cue's why and key order, and nothing else", requestKey("x", { a: 1, b: { d: 2, c: 3 }, why: "p" }) === requestKey("x", { b: { c: 3, d: 2 }, a: 1, why: "q" }) && requestKey("x", { a: 1 }) !== requestKey("x", { a: 2 }) && requestKey("x", { a: 1 }) !== requestKey("y", { a: 1 }));
  // Something different is a new request: it runs (the refusal's one free retry), and leaves its own receipt.
  let second: any = null;
  await quietly(async () => { second = await t.tools.draftEmail.execute({ to: "hello@other.example", subject: "Dinner for 12" }, {}).catch((e: unknown) => e); });
  await settle(2);
  check("a different request still runs, once, with its own receipt", t.runs.length === 2 && second === boom && decisions.length === 2, { runs: t.runs, decisions: decisions.length });
}
{
  // A throw that comes back as done on a different request: done is done, recorded as done.
  decisions.length = 0;
  let n = 0;
  const t = turn({ draftEmail: async () => { if (n++ === 0) throw boom; return { ok: true }; } });
  await quietly(async () => {
    await t.tools.draftEmail.execute({ to: "a@venue.example", subject: "x" }, {}).catch(() => {});
    await t.tools.draftEmail.execute({ to: "b@venue.example", subject: "x" }, {});
  });
  await settle(2);
  check("after a throw, a different request that goes through is recorded as done", decisions.map((d) => d.action).join() === "not_done,done", decisions.map((d) => d.action));
}

// ------------------------------------------------------------ 4. refusals carry their reason in the log
{
  decisions.length = 0;
  const t = turn({
    shareFinds: async () => ({ ok: false, sent: [], refused: ["Jazz at Linden: sold out", "Bar Nine: caption says more than its facts"], note: "Nothing sent." }),
    saveAsk: async () => withReason({ ok: false, error: "couldn't save that as something to look for" }, "couldn't save that as something to look for: the read of the ask timed out (6s)"),
    draftEmail: async () => ({ ok: false, error: "Read the place's page first." }),
  });
  const shared = await quietly(() => t.tools.shareFinds.execute({ what: "jazz" }, {}));
  const saved = await quietly(() => t.tools.saveAsk.execute({ what: "jazz nights" }, {}));
  await quietly(() => t.tools.draftEmail.execute({ to: "x@venue.example", subject: "y" }, {}));
  await settle(3);
  const by = (n: string) => decisions.find((d) => d.decision === `tool.${n}`)?.proposal?.error;
  check("shareFinds' refusal is logged with its refused items, not an empty error", by("shareFinds") === "Jazz at Linden: sold out | Bar Nine: caption says more than its facts", by("shareFinds"));
  check("saveAsk's refusal is logged with its kept reason", by("saveAsk") === "couldn't save that as something to look for: the read of the ask timed out (6s)", by("saveAsk"));
  check("…while the model reads exactly what it did before", saved.error === "couldn't save that as something to look for" && !("reason" in saved) && Array.isArray(shared.refused) && shared.note === "Nothing sent.");
  check("an error is logged as the error, as before", by("draftEmail") === "Read the place's page first.");
  check("refusalReason reads nothing into a result without a failure", refusalReason(null) === "" && refusalReason({ ok: false }) === "");
}
{
  // saveAsk's own reasons, in the code that keeps them (agent/conversationTools.ts).
  const fs = await import("node:fs");
  const ct = fs.readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
  check("saveAsk keeps why it didn't save (threw, timed out, or nothing read) for the log", /withReason\(\{ ok: false, error: "couldn't save that as something to look for" \}/.test(ct) && /the save threw: /.test(ct) && /timed out \(6s\)/.test(ct) && /found no ask to save/.test(ct));
}

console.log(`throw receipts: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
