// Trace text on the in-turn room path (review of #247, 2026-10-19): a member's message mentions an event they're going to
// (profileExtraction storePlannedEventMention), which matches other members going and scores the whole group right away
// (eventMatching matchAndScoreEventMention -> eventScoring scoreMatchedGroup), all inside the triggering member's turn. The
// room-wide read of everyone's asks is nobody's (it holds every guest's words), and each guest's own work (their frame, their
// people facts, their scoring) is filed under that guest, never under the member whose turn started it: a forget by a guest
// must reach every row holding their words.
// Zero tokens and no database: the in-room fake world answers the database, Anthropic and embeddings; the trace-text table
// is an in-memory fake; nothing is sent. Invented people only.
//   npx tsx --import ./evals/lib/modelGuard.mjs evals/langfuse/roomTrace.ts
import { readFileSync } from "fs";
import { W, reset, addMember, ask, check, results } from "../inroom/world.js";
import { NodeSDK } from "@opentelemetry/sdk-node";
import * as T from "../../src/services/llmTraceText.js";

type Stored = { user_id: string | null; function_id: string; input: string | null };
const table: Stored[] = [];
T.traceTextStore.db = async () => ({
  async query(sql: string, args: any[] = []) {
    if (/^INSERT INTO llm_trace_text/.test(sql.trim())) {
      const [tr, , us, fn, inp] = args;
      for (let i = 0; i < tr.length; i++) table.push({ user_id: us[i], function_id: fn[i], input: inp[i] });
      return { rows: [], rowCount: tr.length };
    }
    return { rows: [], rowCount: 0 };
  },
});
const sdk = new NodeSDK({ spanProcessors: [new T.TraceTextSpanProcessor()] });
sdk.start();

const { default: pool } = await import("../../src/db/db.js");
const { storePlannedEventMention } = await import("../../src/services/profileExtraction.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

reset();
const JORDAN_ASK = "a seed investor for climate hardware";
const NOOR_ASK = "backing climate hardware founders at seed";
const ELLIS_ASK = "a cofounder who knows battery chemistry";
const jordan = addMember({ first_name: "Jordan", intent: [ask(JORDAN_ASK)] });
const noor = addMember({ first_name: "Noor", intent: [ask(NOOR_ASK, "offering")] });
const ellis = addMember({ first_name: "Ellis", intent: [ask(ELLIS_ASK)] });
const today = new Date().toISOString().slice(0, 10);
const zero = `[${new Array(1536).fill(0).join(",")}]`;

// The mention tables and the group read, which the in-room world doesn't hold.
const worldQuery = (pool as any).query;
(pool as any).query = async (sql: string, p: any[] = []) => {
  if (/^\s*INSERT INTO planned_event_mentions/.test(sql)) return { rows: [{ id: "mention-1" }], rowCount: 1 };
  if (/FROM planned_event_mentions WHERE id = \$1/.test(sql)) return { rows: [{ id: "mention-1", user_id: jordan.id, event_name_raw: "Climate Supper", event_date: today, embedding: zero }] };
  if (/FROM planned_event_mentions/.test(sql)) return { rows: [noor, ellis].map((m) => ({ user_id: m.id, event_api_id: null, source: "mention" })) };
  if (/FROM surfaced_events/.test(sql)) return { rows: [] };
  if (/WHERE cp\.user_id = ANY\(\$1::uuid\[\]\) AND coalesce\(u\.sms_opted_out, false\) = false/.test(sql))
    return { rows: (p[0] as string[]).map((id) => W.members.get(id)!).filter(Boolean).map((m) => ({ user_id: m.id, first_name: m.first_name, phone_number: m.phone_number, email: m.email, city: m.city, goals: m.goals, blockers: m.blockers, activity_preferences: m.activity_preferences, intent: m.intent })) };
  return worldQuery(sql, p);
};

// Jordan's turn: the mention is stored and the group scored, fire-and-forget, under Jordan's turn mark.
await T.traceTurn(async () => {
  T.noteTraceUser(jordan.id);
  await storePlannedEventMention(jordan.id, { event_name: "Climate Supper", event_date: today, event_location: "San Francisco", quote: "I'm going to Climate Supper" } as any, "I'm going to Climate Supper tonight");
  // Wait for the scoring the mention started (it isn't awaited by the turn), until nothing new is called for a while.
  let last = -1;
  for (let i = 0; i < 100 && W.llmCalls.length !== last; i++) {
    last = W.llmCalls.length;
    await sleep(60);
  }
});
await T.flushTraceText();

const fnRows = (fn: string) => table.filter((r) => r.function_id === fn);
const has = (r: Stored, t: string) => (r.input ?? "").includes(t);
const reads = fnRows("peopleAsks.read");
const roomWide = reads.filter((r) => has(r, JORDAN_ASK) && has(r, NOOR_ASK) && has(r, ELLIS_ASK));
check("the path ran: the group was scored", W.llmCalls.some((c) => c.kind === "score"), W.llmCalls.map((c) => c.kind));
check("the room-wide read of everyone's asks ran", roomWide.length >= 1, reads.map((r) => r.user_id));
check("the room-wide read is filed under nobody, not the member whose turn started it", roomWide.length >= 1 && roomWide.every((r) => r.user_id === null), roomWide.map((r) => r.user_id));
// The stub can't read asks, so each guest's frame reads their own asks again: under that guest.
for (const [m, a] of [[jordan, JORDAN_ASK], [noor, NOOR_ASK], [ellis, ELLIS_ASK]] as const) {
  const own = reads.filter((r) => has(r, a) && !roomWide.includes(r));
  check(`${m.first_name}'s own frame read is filed under ${m.first_name}`, own.length >= 1 && own.every((r) => r.user_id === m.id), own.map((r) => r.user_id));
}
// Each guest's people facts (peopleGraph) read their own words: under them.
const graphRows = table.filter((r) => /Below is what a member of a private social club has said/.test(r.input ?? ""));
check("the people-facts reads ran", graphRows.some((r) => has(r, NOOR_ASK)), graphRows.length);
for (const [m, a] of [[jordan, JORDAN_ASK], [noor, NOOR_ASK], [ellis, ELLIS_ASK]] as const) {
  const theirs = graphRows.filter((r) => has(r, a));
  check(`${m.first_name}'s people-facts read is filed under ${m.first_name}`, theirs.every((r) => r.user_id === m.id), theirs.map((r) => r.user_id));
}
// The whole point: no read of the room or of another guest's own words is filed under Jordan. (Jordan's own scoring and
// drafts quote the others' shared asks; those are Jordan's work and stay his.)
const strays = table.filter((r) => r.user_id === jordan.id && ["peopleAsks.read", "peopleGraph.facts"].includes(r.function_id) && (has(r, NOOR_ASK) || has(r, ELLIS_ASK)));
check("no room-wide or other guest's read is filed under the triggering member", strays.length === 0, strays.map((r) => r.function_id));

// Pins: where the marks sit in eventScoring.ts.
const E = readFileSync(new URL("../../src/services/eventScoring.ts", import.meta.url), "utf8");
check("pin: the room-wide read runs under nobody's mark", /await withTraceUser\(null, \(\) => readPeopleAsks\(texts\)\)\.catch\(\(\) => \[\]\)/.test(E));
check("pin: each person's frame runs under their mark", /await withTraceUser\(person\.user_id, \(\) => roomFrame\(person\.intent\)\)/.test(E));
check("pin: each person's ask solicitation runs under their mark", /await withTraceUser\(person\.user_id, \(\) =>\n\s*runEventAskSolicitationAgent\(/.test(E));
check("pin: each guest's people facts refresh under their mark", /await withTraceUser\(id, \(\) => refreshPeopleFacts\(id\)\)/.test(readFileSync(new URL("../../src/services/peopleGraph.ts", import.meta.url), "utf8")));

await sdk.shutdown().catch(() => {});
console.log(`room trace text: ${results.total - results.failed}/${results.total} passed`);
process.exit(results.failed ? 1 : 0);
