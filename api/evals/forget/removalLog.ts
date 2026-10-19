// The removal's own log (forget-delete-spec.md section 2 row 26, section 7.4): kind, day and the corrections row id only.
// Layer 1: a fake database, no model, zero tokens.
//   npx tsx evals/forget/removalLog.ts
//
// Invented member Ellis removes "the custody hearing in May" (a claim). The decision-log rows written for that removal must hold no
// word of it, no word of his message asking for it, and no hash-shaped value. A correction keeps its log as before.
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { default: pool } = await import("../../src/db/db.js");
const W = await import("../../src/services/whatCoKnows.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };

const U = "00000000-0000-4000-8000-0000000e1116";
const FACT = "the custody hearing in May";
const OTHER = "Ellis moved to Oakland";
let decisions: { decision: string; action: string | null; proposal: any; checks: any; reason: string | null }[] = [];
let corrections: any[][] = [];
let claims: any[] = [];
let tasks: any[] = [];
let nextId = 501;
const handle = async (sql: string, p: any[] = []) => {
  if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(sql) || /pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 };
  if (/INSERT INTO harness_decisions/.test(sql)) { decisions.push({ decision: p[1], action: p[4], proposal: p[5] ? JSON.parse(p[5]) : null, checks: JSON.parse(p[6] ?? "[]"), reason: p[8] ?? null }); return { rows: [], rowCount: 1 }; }
  if (/INSERT INTO profile_corrections/.test(sql)) { corrections.push(p); return { rows: [{ id: String(nextId++) }], rowCount: 1 }; }
  if (/FROM member_claims WHERE user_id = \$1 ORDER BY said_on/.test(sql)) return { rows: claims };
  if (/DELETE FROM member_claims WHERE id = \$1/.test(sql)) { const n = claims.length; claims = claims.filter((c) => c.id !== p[0]); return { rows: [], rowCount: n - claims.length }; }
  if (/UPDATE member_claims SET text = \$3/.test(sql)) { const c = claims.find((x) => x.id === p[0]); if (c) c.text = p[2]; return { rows: [], rowCount: c ? 1 : 0 }; }
  if (/SELECT id, goal, target_key FROM co_tasks WHERE user_id = \$1 AND status = 'open'/.test(sql)) return { rows: tasks };
  if (/UPDATE co_tasks SET status = 'dropped'/.test(sql)) { const t = tasks.find((x) => String(x.id) === String(p[0])); return { rows: t ? [{ kind: "work", source: "promise", followup: null, goal: t.goal }] : [], rowCount: t ? 1 : 0 }; }
  return { rows: [], rowCount: 0 };
};
(pool as any).query = handle;
(pool as any).connect = async () => ({ query: handle, release: () => {} });
const reset = () => {
  decisions = []; corrections = []; nextId = 501;
  claims = [
    { id: "c1", text: `They have ${FACT}.`, provenance: "user_said", kind: "deadline", quote: "custody hearing in May", expires_on: null },
    { id: "c2", text: `${OTHER}.`, provenance: "user_said", kind: "city", quote: "moved to Oakland", expires_on: null },
  ];
  tasks = [{ id: 9, goal: `Send Ellis prep notes for ${FACT}`, target_key: null }];
};
const words = (t: string) => t.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
const says = (row: unknown, text: string) => { const j = JSON.stringify(row).toLowerCase(); return words(text).some((w) => j.includes(w)); };
const hashy = (row: unknown) => /[0-9a-f]{8,}/i.test(JSON.stringify(row));
const theirWords = "please forget the custody hearing thing";

// ---- 1. a removal
reset();
const r = await W.applyKnowledgeChanges(U, [{ action: "remove", refs: ["claim:c1"] } as any], { message: theirWords, theirWords });
check("the removal was applied (the fixture reaches the log)", r.ok && r.applied.length === 1 && !claims.some((c) => c.id === "c1"));
const rm = decisions.find((d) => d.decision === "knowledge.remove");
check("knowledge.remove is logged", !!rm);
check("its proposal is kind + day + corrections row id, nothing else", !!rm && JSON.stringify(Object.keys(rm.proposal).sort()) === JSON.stringify(["id", "kind", "on"]) && rm.proposal.id === 501 && /^\d{4}-\d{2}-\d{2}$/.test(rm.proposal.on) && rm.proposal.kind === "what they told Cue");
check("no word (4+ letters) of the removed text in the removal's row", !!rm && !says(rm, FACT));
check("no word of their message asking for it in the removal's row", !!rm && !says(rm, "custody hearing"));
check("no hash-shaped value (8+ hex) in the removal's row", !!rm && !hashy(rm));
const cq = decisions.filter((d) => d.decision === "knowledge.cancel_queued");
check("what the removal took out of line is logged by id and kind, not its words", cq.length === 1 && cq[0].proposal.id === "9" && !("what" in cq[0].proposal) && !says(cq[0], FACT));
const rel = decisions.find((d) => d.decision === "commitment.outcome");
check("the released commitment's row has no task words and no words of theirs", !!rel && rel.proposal.what === null && !("theirWord" in rel.proposal) && !says(rel, FACT));
check("no row written for this removal says it, anywhere in the log", decisions.every((d) => !says(d, "custody hearing")));
check("the corrections row itself is unchanged by this PR (the marker store is Royce's call, spec section 4)", corrections.length === 1 && corrections[0][2] === `They have ${FACT}.`);

// ---- 2. a correction keeps its log as before
reset();
await W.applyKnowledgeChanges(U, [{ action: "correct", refs: ["claim:c2"], now: "Ellis moved to Berkeley" } as any], { message: "actually I moved to Berkeley", theirWords: "actually I moved to Berkeley" });
const co = decisions.find((d) => d.decision === "knowledge.correct");
check("a correction still logs ref, was, now and their words", !!co && co.proposal.ref === "claim:c2" && /Oakland/.test(co.proposal.was) && /Berkeley/.test(co.proposal.now) && /Berkeley/.test(co.proposal.theirWords));

// ---- 3. a correction in the same message as a removal doesn't log that message
reset();
const both = "forget the custody hearing, and I moved to Berkeley";
await W.applyKnowledgeChanges(U, [{ action: "remove", refs: ["claim:c1"] } as any, { action: "correct", refs: ["claim:c2"], now: "Ellis moved to Berkeley" } as any], { message: both, theirWords: both });
check("mixed message: no row says the removed thing", decisions.length >= 2 && decisions.every((d) => !says(d, "custody hearing")));
check("mixed message: the correction keeps was/now", decisions.some((d) => d.decision === "knowledge.correct" && /Berkeley/.test(d.proposal.now)));

// ---- 4. a removal that's refused (a ref not on file, made up from the text) logs kinds and reasons only
reset();
await W.applyKnowledgeChanges(U, [{ action: "remove", refs: ["custody hearing in May"] } as any], { message: theirWords, theirWords });
const ref = decisions.find((d) => d.decision === "knowledge.change_refused");
check("refused removal: logged, with the reason", !!ref && ref.proposal.refused.length === 1 && ref.proposal.refused[0].kind === "an item" && /not one of the items/.test(ref.proposal.refused[0].why));
check("refused removal: no word of it or of their message, no hash", !!ref && !says(ref, "custody hearing") && !hashy(ref) && !("theirWords" in ref.proposal));

// ---- 5. the pure halves
check("logKind: a known kind gets its words; a made-up ref is 'an item'; an odd profile field is generic", W.logKind("claim:c1") === "what they told Cue" && W.logKind("the custody hearing") === "an item" && W.logKind("profile:custody hearing") === "a profile field" && W.logKind("profile:city") === "city");
check("removalLog: kind, day, id; a missing id is null", JSON.stringify(W.removalLog("goals", "12", new Date("2026-10-18T12:00:00Z"))) === '{"kind":"goals","on":"2026-10-18","id":12}' && W.removalLog("goals", undefined).id === null);

console.log(`removal log: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
