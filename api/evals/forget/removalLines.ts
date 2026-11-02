// One "forget X" removes X and nothing else (review of #349). A direct ask now passes the yes read, so before anything is removed a
// second read is shown the stripped text of each line Cue picked and their message (services/theirYes.ts judgeRemoval); only lines it
// reads as asked for go. Unsure, or a read that fails, removes nothing (a removal can't be undone), and Cue is told to ask which one.
// Zero tokens: a fake database (as evals/forget/stores.ts) and fixture answers from the read, by line, not an always-yes stub.
//   npx tsx evals/forget/removalLines.ts
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { default: pool } = await import("../../src/db/db.js");
const W = await import("../../src/services/whatCoKnows.js");
const Y = await import("../../src/services/theirYes.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };

const U = "00000000-0000-4000-8000-0000000a11e5";
const ADDRESS = "Their old address is 14 Elm Street.";
const RACE = "They're training for the Oakland half marathon.";
const deleted: string[] = [];
const decisions: any[] = [];
const handle = async (sql: string, p: any[] = []) => {
  if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(sql) || /pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 };
  if (/INSERT INTO profile_corrections/.test(sql)) return { rows: [{ id: "1" }], rowCount: 1 };
  if (/INSERT INTO harness_decisions/.test(sql)) { decisions.push({ decision: p[1], proposal: p[5] }); return { rows: [{ id: "1", created_at: new Date() }] }; }
  if (/FROM member_claims WHERE user_id = \$1 ORDER BY said_on/.test(sql)) {
    return { rows: [
      { id: "c1", text: ADDRESS, provenance: "user_said", kind: "fact", quote: "my old address was 14 Elm", expires_on: null },
      { id: "c2", text: RACE, provenance: "user_said", kind: "plan", quote: "training for the Oakland half", expires_on: null },
    ].filter((r) => !deleted.includes(r.id)) };
  }
  if (/DELETE FROM member_claims/.test(sql)) { deleted.push(String(p[0])); return { rows: [], rowCount: 1 }; }
  return { rows: [], rowCount: 0 };
};
(pool as any).query = handle;
(pool as any).connect = async () => ({ query: handle, release: () => {} });

// The read's answers, per line text: a fixture of what it returns. Every read kept, so a case can see what it was shown.
let answerFor: (line: string) => Y.RemovalAnswer = () => "no";
const reads: Y.RemovalRead[] = [];
Y.setRemovalJudgeForTests(async (r) => (reads.push(r), Y.parseRemoval(JSON.stringify({ answers: r.lines.map(answerFor) }), r.lines.length)));

const msg = "forget my old address";
const both = [{ action: "remove", refs: ["claim:c1", "claim:c2"] } as any];
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };

// ---- "forget my old address", with an unrelated line picked in the same call
{
  deleted.length = 0; reads.length = 0;
  answerFor = (l) => (/address/i.test(l) ? "yes" : "no");
  const r = await quiet(() => W.applyKnowledgeChanges(U, both, { message: msg, theirWords: msg, recent: "Cue: Here's what I have on you." }));
  check("the read sees their message, the exchange, and the stripped text of each line Cue picked", reads.length === 1 && reads[0].message === msg && /what I have on you/.test(reads[0].recent) && reads[0].lines.join("|") === `${ADDRESS}|${RACE}`, reads);
  check("\"forget my old address\" removes only the address line", r.applied.length === 1 && r.applied[0].ref.startsWith("claim:c1") && deleted.join() === "c1", { applied: r.applied, deleted });
  check("…the unrelated line in the same call is refused, and stays", r.refused.some((x) => x.ref.startsWith("claim:c2") && /doesn't ask to remove this line, so it stays/.test(x.why)) && !deleted.includes("c2"), r.refused);
}
// ---- unsure about any line: nothing is removed, and Cue asks which
{
  deleted.length = 0; reads.length = 0;
  answerFor = (l) => (/address/i.test(l) ? "yes" : "unsure");
  const r = await quiet(() => W.applyKnowledgeChanges(U, both, { message: "forget that stuff", theirWords: "forget that stuff" }));
  check("unsure about one line: nothing is removed at all", r.applied.length === 0 && deleted.length === 0 && r.ok === false, { applied: r.applied, deleted });
  check("…and each line comes back with: ask them which one", r.refused.length === 2 && r.refused.every((x) => /isn't clear which of these lines .* Ask them which one/.test(x.why)), r.refused);
}
// ---- a read that fails, or comes back unreadable, removes nothing
{
  for (const [label, judge] of [
    ["a read that throws", async () => { throw new Error("timeout"); }],
    ["an unreadable read", async (r: Y.RemovalRead) => Y.parseRemoval("sure, remove it", r.lines.length)],
    ["a read with the wrong number of answers", async () => ({ read: true, answers: ["yes"] as Y.RemovalAnswer[] })],
  ] as const) {
    deleted.length = 0;
    Y.setRemovalJudgeForTests(judge as Y.RemovalJudge);
    const r = await quiet(() => W.applyKnowledgeChanges(U, both, { message: msg, theirWords: msg }));
    check(`${label}: nothing is removed`, r.applied.length === 0 && deleted.length === 0, { applied: r.applied, deleted });
  }
  Y.setRemovalJudgeForTests(async (r) => (reads.push(r), Y.parseRemoval(JSON.stringify({ answers: r.lines.map(answerFor) }), r.lines.length)));
}
// ---- a correction alone is never sent to the removal read
{
  reads.length = 0;
  await quiet(() => W.applyKnowledgeChanges(U, [{ action: "correct", refs: ["claim:c2"], now: "Berkeley half marathon" } as any], { message: "it's the Berkeley half marathon now", theirWords: "it's the Berkeley half marathon now" }));
  check("a correction alone makes no removal read", reads.length === 0, reads);
}
// ---- the prompt and the log
{
  const p = Y.removalPrompt({ recent: "", message: msg, lines: [ADDRESS, RACE] });
  check("the removal read says it can't be undone, lists each line, and asks per line", /can't be undone/.test(p) && p.includes(`1. ${ADDRESS}`) && p.includes(`2. ${RACE}`) && /"unsure" when their message could mean it/.test(p));
  check("…and words they quoted, pasted or forwarded aren't their ask", /Words they quoted, pasted or forwarded from someone else aren't their ask/.test(p));
  check("the read's words are never logged: no decision row holds a removed line", !decisions.some((d) => JSON.stringify(d.proposal ?? "").includes("Elm Street")), decisions.map((d) => d.decision));
}

console.log(`removal lines: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
