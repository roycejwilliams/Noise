// Forgetting, store by store (forget-delete-spec.md sections 2 and 7): what a removal is meant to do to each store, run against what
// it does today. Layer 1: a fake database, no model, zero tokens.
//   npx tsx evals/forget/stores.ts
//
// Invented member Ellis has "the custody hearing in May" in every store, plus a canary he never removes. He removes it
// (applyKnowledgeChanges, as the correctWhatCoKnows tool runs it). For each store the test asks: did the removal delete or redact
// the row that says it? The fake database records every statement; a store counts as handled only when the removal issued a DELETE
// on it, or an UPDATE that rewrites its text (a status change alone leaves the words).
//
// Stores the removal already handles are real checks. The rest are KNOWN GAPs, pending Royce's approval of deletion: they print as
// such and don't fail the gate. They are strict: if one starts passing (the delete got built), it FAILS until it's moved to a real
// check here, so this file can't go stale. Nothing here deletes anything; it only reads what a fake database was asked to do.
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { default: pool } = await import("../../src/db/db.js");
const W = await import("../../src/services/whatCoKnows.js");
const { goalHash } = await import("../../src/services/goalEdges.js");

let total = 0, failed = 0, gaps = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const PENDING = "pending Royce's approval of deletion";
// Expected to fail today. Printed, not failed; an unexpected pass fails (strict), so the gap list stays true.
const knownGap = (store: string, intended: string, handledNow: boolean) => {
  total++;
  if (handledNow) { failed++; console.log(`FAIL known gap now closed, move it to a real check: ${store}: ${intended}`); return; }
  gaps++;
  console.log(`KNOWN GAP (${PENDING}): ${store}: ${intended}`);
};

const U = "00000000-0000-4000-8000-0000000e1117";
const FACT = "the custody hearing in May";
const said: { sql: string; p: any[] }[] = [];
let profileIntent: any[] = [];
const handle = async (sql: string, p: any[] = []) => {
  said.push({ sql, p });
  if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(sql) || /pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 };
  if (/INSERT INTO profile_corrections/.test(sql)) return { rows: [{ id: "1" }], rowCount: 1 };
  if (/FROM co_profiles WHERE user_id = \$1/.test(sql) && /intent/.test(sql)) return { rows: [{ city: "Oakland", long_term_direction: null, availability_pattern: null, goals: [], life_chapters: [], blockers: [], activity_preferences: [], avoid: [], intent: profileIntent }] };
  if (/FROM member_claims WHERE user_id = \$1 ORDER BY said_on/.test(sql)) return { rows: [{ id: "c1", text: `They have ${FACT}.`, provenance: "user_said", kind: "deadline", quote: "custody hearing in May", expires_on: null }, { id: "c2", text: "They want to meet climate founders.", provenance: "user_said", kind: "plan", quote: "climate founders", expires_on: null }] };
  if (/DELETE FROM member_claims|UPDATE co_profiles SET intent|DELETE FROM goal_states/.test(sql)) return { rows: [], rowCount: 1 };
  if (/FROM proactive_candidates WHERE user_id = \$1 AND status = 'pending'/.test(sql)) return { rows: [{ id: 3, type: "followup", target_key: "x", summary: `Check in about ${FACT}`, payload: "{}" }] };
  if (/SELECT id, goal, target_key FROM co_tasks WHERE user_id = \$1 AND status = 'open'/.test(sql)) return { rows: [{ id: 9, goal: `Prep notes for ${FACT}`, target_key: null }] };
  if (/FROM deferred_sends WHERE user_id = \$1 AND status = 'queued'/.test(sql)) return { rows: [{ id: 5, type: "followup", target_key: "y", messages: JSON.stringify([`Thinking of you before ${FACT}`]), after: "{}" }] };
  if (/^\s*UPDATE (proactive_candidates|co_tasks|deferred_sends)/.test(sql)) return { rows: [{ kind: "work", source: "member", followup: null, goal: `Prep notes for ${FACT}` }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};
(pool as any).query = handle;
(pool as any).connect = async () => ({ query: handle, release: () => {} });

const theirWords = "please forget the custody hearing thing";
const r = await W.applyKnowledgeChanges(U, [{ action: "remove", refs: ["claim:c1"] } as any], { message: theirWords, theirWords });
check("the removal ran (the fixture reaches every store below)", r.ok && r.applied.length === 1);

// What the removal asked the database to do, per table.
const words = (t: string) => t.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
const sayingIt = (p: any[]) => { const j = JSON.stringify(p).toLowerCase(); return words(FACT).some((w) => j.includes(w)); };
const deleted = (table: string, also: RegExp = /./) => said.some((s) => new RegExp(`^\\s*DELETE FROM ${table}\\b`, "i").test(s.sql) && also.test(s.sql));
// An UPDATE that rewrites one of the store's text columns, with nothing of the fact in what it writes.
const rewrote = (table: string, cols: string[], also: RegExp = /./) => said.some((s) => new RegExp(`^\\s*UPDATE ${table}\\b`, "i").test(s.sql) && also.test(s.sql) && cols.some((c) => new RegExp(`SET[\\s\\S]*\\b${c}\\s*=`, "i").test(s.sql)) && !sayingIt(s.p));
const handled = (table: string, cols: string[], also?: RegExp) => deleted(table, also) || rewrote(table, cols, also);

// ---------------------------------------------------------------- real checks: done today
check("member_claims (spec 8): the claim row is deleted", deleted("member_claims"));
check("proactive_candidates, deferred_sends, co_tasks (spec 15-16, open/queued): taken out of line", said.some((s) => /^\s*UPDATE proactive_candidates SET status = 'skipped'/.test(s.sql)) && said.some((s) => /^\s*UPDATE deferred_sends SET status = 'skipped'/.test(s.sql)) && said.some((s) => /^\s*UPDATE co_tasks SET status = 'dropped'/.test(s.sql)));
check("harness_decisions: a knowledge.remove row is written", said.some((s) => /INSERT INTO harness_decisions/.test(s.sql) && s.p[1] === "knowledge.remove"));
{
  // A goal removal: out of the intent list, and its goal state deleted (spec 9-10).
  said.length = 0;
  profileIntent = [{ id: "g1", kind: "goal", text: "get through the custody hearing in May", status: "active", created_at: new Date().toISOString() }, { id: "g2", kind: "goal", text: "meet climate founders", status: "active", created_at: new Date().toISOString() }];
  const g = await W.applyKnowledgeChanges(U, [{ action: "remove", refs: ["goal:g1"] } as any], { message: theirWords, theirWords });
  const upd = said.find((s) => /UPDATE co_profiles SET intent/.test(s.sql));
  check("co_profiles intent (spec 9): a removed goal leaves the list, the canary goal stays", g.ok && !!upd && !/custody/i.test(String(upd.p[1])) && /climate founders/.test(String(upd.p[1])));
  check("goal_states (spec 10): the goal's state row is deleted", said.some((s) => /DELETE FROM goal_states/.test(s.sql) && s.p[1] === goalHash("get through the custody hearing in May")));
  // Back to the claim removal's statements for the gaps below.
  said.length = 0;
  profileIntent = [];
  await W.applyKnowledgeChanges(U, [{ action: "remove", refs: ["claim:c1"] } as any], { message: theirWords, theirWords });
}

// ---------------------------------------------------------------- known gaps: what the spec says should happen (section 2), not built
const MEM = (t: RegExp) => t;
knownGap("co_memories text_exchange, their texts (spec 1)", "the line that says it is redacted to \"[removed]\"; the row is deleted if nothing is left", handled("co_memories", ["content"], MEM(/text_exchange|co_memories/)));
knownGap("co_memories text_exchange, Cue's lines and [Call] notes (spec 2)", "Cue's lines that repeat it are redacted the same way", handled("co_memories", ["content"], /Co replied|\[Call\]/));
knownGap("the removal message itself (spec 3)", "stored as \"(asked Cue to forget something; done)\" (today rewritten only at read)", handled("co_memories", ["content"], /asked Cue to forget/));
knownGap("co_memories call_transcript (spec 4)", "the sentence is redacted in their turn and in Cue's turns that echo it", handled("co_memories", ["content"], /call_transcript/));
knownGap("co_memories.content_embedding (spec 5)", "set NULL in the same transaction for every changed row", rewrote("co_memories", ["content_embedding"]));
knownGap("co_memories recap rows (spec 6)", "every old recap row that says it is deleted; the current recap is rebuilt", deleted("co_memories", /recap/));
knownGap("co_memories co_lesson / recommendation / promise_result (spec 7)", "rows that say it are deleted", deleted("co_memories", /co_lesson|recommendation|promise_result/));
knownGap("co_profiles trajectory_embedding (spec 9)", "recomputed after the change", rewrote("co_profiles", ["trajectory_embedding"]));
knownGap("co_goals (spec 11)", "the goal row is deleted, or the item redacted", handled("co_goals", ["title", "their_words", "items"]));
knownGap("member_threads (spec 12)", "the row is deleted (today: status 'changed', closed_quote keeps their words)", deleted("member_threads"));
knownGap("person_snapshot_claims (spec 13)", "snapshot claims that say it are deleted", deleted("person_snapshot_claims"));
knownGap("open_loops (spec 14)", "loops that say it are deleted", deleted("open_loops"));
knownGap("co_tasks, closed tasks too (spec 15)", "matching notes and words redacted, open and closed", rewrote("co_tasks", ["goal", "their_words", "notes"]));
knownGap("proactive_candidates / deferred_sends / network_backlogs text (spec 16)", "text deleted or redacted, sent rows too (today: skipped, text kept)", handled("proactive_candidates", ["summary", "payload"]) && handled("deferred_sends", ["messages"]));
knownGap("co_facts wants/offers (spec 17)", "deleted (today: retired, label kept)", deleted("co_facts", /wants|offers/));
knownGap("co_facts, Cue's ledger (spec 18)", "rows whose label says it are deleted", deleted("co_facts", /subject = 'co'|relation = 'sent'/));
knownGap("relevance_edges, they're the asker (spec 19)", "deleted (today: retired)", deleted("relevance_edges", /person_id/));
knownGap("relevance_edges, they're the candidate (spec 20)", "rows whose match_reason says it are deleted", deleted("relevance_edges", /candidate_id/));
knownGap("event_guest_rankings and value-line caches (spec 21)", "rows for open events that say it are deleted", deleted("event_guest_rankings"));
knownGap("document_deliveries.content / co_pages.data (spec 22)", "the line redacted in our copy; the hosted page updates at the same link", handled("document_deliveries", ["content"]) && handled("co_pages", ["data"]));
knownGap("research_finds / search_briefs / link_reads (spec 23)", "rows that say it are deleted", deleted("research_finds") && deleted("search_briefs") && deleted("link_reads"));
knownGap("emotion_signals / member_advice / member_milestones (spec 24)", "rows that say it are deleted", deleted("emotion_signals") && deleted("member_advice") && deleted("member_milestones"));
knownGap("harness_decisions, the member's text in other rows (spec 26)", "the member's text redacted in their rows (the removal's own row: draft #256)", rewrote("harness_decisions", ["proposal"]));
knownGap("profile_corrections, the marker (spec 29)", "kind + date + ref id only: old_value, quote and the hash in item_ref not stored", said.some((s) => /INSERT INTO profile_corrections/.test(s.sql) && !sayingIt(s.p) && !/[0-9a-f]{8}/.test(String(s.p[5]))));

console.log(`forget stores: ${total - failed}/${total} passed (${gaps} known gaps, ${PENDING})`);
if (failed) process.exitCode = 1;
process.exit();
