// Model-free checks for the transitions section of the member picture (Cue Memory Spec step 2, 2026-11-05): a transition is a kind of
// member_threads row (harness/memberThreads.ts), read by services/memberKnowledge.ts. No database, no model.
//   npx tsx evals/member/transitions.ts
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const MK = await import("../../src/services/memberKnowledge.js");
const MT = await import("../../src/harness/memberThreads.js");
type Deps = import("../../src/services/memberKnowledge.js").KnowledgeDeps;
type Raw = import("../../src/services/memberKnowledge.js").RawTransition;

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const root = new URL("../../src/", import.meta.url).pathname;
const src = (p: string) => readFileSync(join(root, p), "utf8");

// ---------------------------------------------------------------- opened with its quote, date and source
const at = (iso: string) => iso.slice(0, 16);
const lines = [
  { at: at("2026-10-20T15:00"), text: "I'm moving to Austin in January, got a new role there", via: "text" as const },
  { at: at("2026-10-22T18:00"), text: "honestly I think I'm going to go solo after this", via: "call" as const },
];
const gate = (opens: any[], closes: any[] = [], onFile: any[] = []) => MT.gateThreadChanges(opens, closes, onFile, lines, null);
const g1 = gate([{ text: "moving to Austin for a new role", quote: "I'm moving to Austin in January", transition: "said" }]);
check("opened: kept with their quote", g1.opened.length === 1 && g1.opened[0].quote === "I'm moving to Austin in January");
check("opened: dated from their line", g1.opened[0].quotedAt === "2026-10-20T15:00");
check("opened: source said, channel text", g1.opened[0].transition === "said" && g1.opened[0].transitionChannel === "text");
const g2 = gate([{ text: "going solo", quote: "I'm going to go solo after this", transition: "inferred" }]);
check("opened from a call: channel call, inferred stays inferred", g2.opened[0]?.transition === "inferred" && g2.opened[0]?.transitionChannel === "call");
const g3 = gate([{ text: "moving to Austin for a new role", quote: "I'm moving to Austin in January" }]);
check("an ordinary thread has no transition and no channel", g3.opened[0].transition === null && g3.opened[0].transitionChannel === null);
const g4 = gate([{ text: "moving to Austin", quote: "I'm moving to Boston in January", transition: "said" }]);
check("a transition without their own words is refused", g4.opened.length === 0);
const g5 = gate([{ text: "moving to Austin for a new role", quote: "I'm moving to Austin in January", transition: "maybe" }]);
check("an unknown kind is read as an ordinary thread", g5.opened[0].transition === null);
check("the model's proposal carries the kind in the prompt shape (one field, no new call)", /"transition": null/.test(MT.threadsPrompt("Jordan", [], lines)) && !/generateText/.test(src("harness/memberThreads.ts").split("export function gateThreadChanges")[0].replace(/^import.*$/gm, "")));

// ---------------------------------------------------------------- a correction qualifies, never overwrites
const onFile = [
  { id: "t1", text: "moving to Austin", openedQuote: "I'm moving to Austin in January", openedAt: "2026-10-01T10:00:00.000Z", status: "open", feeling: null, dueDate: null, nextStep: "check_in", kind: "thread", closedQuote: null, lastTouchedAt: "2026-10-01T10:00:00.000Z", transition: "said", transitionChannel: "text" },
] as any[];
const g6 = MT.gateThreadChanges([], [{ id: "t1", status: "changed", quote: "I'm going to go solo after this", newText: "going solo instead of moving" }], onFile, lines, null);
check("a change closes the earlier one with their words and opens the later one as a transition too", g6.closed.length === 1 && g6.opened.length === 1 && g6.opened[0].transition === "said");
const threadsSrc = src("harness/memberThreads.ts");
check("the writer never rewrites a thread's text or opening quote (only closes it or touches it)", !/UPDATE member_threads SET (?:[^`]*\b)?(?:text|opened_quote|opened_at|transition_source)\s*=/.test(threadsSrc));

// ---------------------------------------------------------------- the section: closed = one dated line, corrections kept
const d = (iso: string) => new Date(iso);
const row = (o: Partial<Raw> & { id: string }): Raw => ({
  text: "moving to Austin",
  quote: "I'm moving to Austin in January",
  openedAt: d("2026-10-20T15:00:00Z"),
  status: "open",
  closedQuote: null,
  closedAt: null,
  lastTouchedAt: d("2026-10-25T12:00:00Z"),
  source: "said",
  channel: "text",
  corrections: [],
  ...o,
});
const base = (raw: Raw[], removedRefs: { old: string; ref: string }[] = []): Partial<Deps> => ({
  profile: async () => ({ firstName: "Jordan", city: null, goals: null, intent: null, updatedAt: null }),
  zone: async () => null,
  linkedNames: async () => ["Maya"],
  transitions: async () => raw,
  forgotten: async () => removedRefs.map((r) => ({ field: "thread", old: r.old, now: null, ref: r.ref, removed: true })),
});
const read = (raw: Raw[], removed: { old: string; ref: string }[] = [], deps: Partial<Deps> = {}) => MK.memberKnowledge("u1", { include: ["transitions"] }, { ...base(raw, removed), ...deps });

const open1 = row({ id: "a" });
const closed = row({ id: "b", text: "starting at the agency", quote: "I start at the agency Monday", status: "resolved", closedAt: d("2026-10-28T09:00:00Z"), closedQuote: "first week done, it's fine", lastTouchedAt: d("2026-10-28T09:00:00Z"), openedAt: d("2026-09-01T09:00:00Z") });
const changed = row({ id: "c", text: "moving to Boston", status: "changed", closedAt: d("2026-10-26T09:00:00Z"), closedQuote: "actually we're not moving, just a long visit", lastTouchedAt: d("2026-10-26T09:00:00Z") });
const k = await read([closed, open1, changed]);
const t = k.transitions!;
check("open comes first, then closed most recent first", t.map((x) => x.id).join() === "a,b,c" && t[0].status === "open");
check("an open one carries quote, opened date, source, status in full", t[0].quote === "I'm moving to Austin in January" && t[0].openedOn === "2026-10-20" && t[0].source === "said" && t[0].channel === "text" && t[0].status === "open");
check("a closed one shrinks to one dated line (no quote, opened and closed days)", t[1].quote === null && t[1].openedOn === "2026-09-01" && t[1].closedOn === "2026-10-28" && t[1].status === "resolved");
check("a correction qualifies: the earlier text stays, their words are carried", t[2].text === "moving to Boston" && t[2].corrections.length === 1 && t[2].corrections[0].was === "moving to Boston" && t[2].corrections[0].quote === "actually we're not moving, just a long visit");
const edited = await read([row({ id: "e", corrections: [{ at: d("2026-10-27T10:00:00Z"), was: "moving to Austin", now: "moving to Austin, later than planned", quote: "later than planned" }] })]);
check("a correction row from the corrections table keeps was and now", edited.transitions![0].corrections[0].was === "moving to Austin" && edited.transitions![0].corrections[0].now === "moving to Austin, later than planned");
check("every item is stamped verifiedAt", t.every((x) => !!x.verifiedAt));
check("without opting in, the section is empty and its loader never runs", await (async () => { let ran = false; const kk = await MK.memberKnowledge("u1", { include: [] }, { ...base([open1]), transitions: async () => { ran = true; return [open1]; } }); return !ran && kk.transitions!.length === 0; })());
check("the default read does not include it (no new load for existing callers)", !(MK.KNOWLEDGE_SECTIONS as readonly string[]).includes("transitions") && (MK.OPT_IN_SECTIONS as readonly string[]).includes("transitions"));

// ---------------------------------------------------------------- budget and ranking
const many = Array.from({ length: 40 }, (_, i) => row({ id: `o${i}`, text: `thing ${i} ${"x".repeat(60)}`, lastTouchedAt: d(`2026-10-${String(1 + (i % 28)).padStart(2, "0")}T12:00:00Z`) })).concat(
  Array.from({ length: 10 }, (_, i) => row({ id: `c${i}`, status: "resolved", closedAt: d(`2026-10-${String(1 + i).padStart(2, "0")}T12:00:00Z`) })),
);
const small = MK.transitionsOf(many, 1500);
check("the budget bounds the section", JSON.stringify(small.items).length <= 1500 + JSON.stringify(small.items[0]).length && small.items.length < many.length);
check("what the budget leaves out is counted, never silent", small.omitted === many.length - small.items.length && small.omitted > 0);
check("rank holds under the budget: open before closed, newest touched first", small.items.every((x) => x.status === "open") && small.items.every((x, i, a) => i === 0 || a[i - 1].verifiedAt >= x.verifiedAt));
const tiny = MK.transitionsOf([open1, closed], 10);
check("a budget smaller than one item still returns the top item", tiny.items.length === 1 && tiny.items[0].id === "a" && tiny.omitted === 1);
const full = MK.transitionsOf(many, 1_000_000);
check("no fixed count or age cutoff when the budget allows", full.items.length === many.length && full.omitted === 0);
check("the budget is a character budget in code, not a count", /TRANSITIONS_BUDGET_CHARS = \d+/.test(src("services/memberKnowledge.ts")) && !/slice\(0, (?:5|6|8|10|12)\)[^\n]*transition/i.test(src("services/memberKnowledge.ts")));

// ---------------------------------------------------------------- forgotten content is not returned; guards fail closed
const rem = await read([open1, row({ id: "r", text: "leaving my marriage", quote: "I'm leaving my marriage", status: "changed", closedQuote: "forget the marriage thing", closedAt: d("2026-10-27T09:00:00Z") })], [{ old: "leaving my marriage", ref: "thread:r" }]);
check("a removed transition is not returned", rem.transitions!.map((x) => x.id).join() === "a" && !JSON.stringify(rem).includes("marriage"));
const remText = await read([row({ id: "s", text: "the divorce with Pat", quote: "the divorce with Pat is final" }), open1], [{ old: "the divorce with Pat", ref: "snapshot:weighingOn:1" }]);
check("a transition saying a removed thing is dropped even from another item's removal", remText.transitions!.every((x) => !/divorce/.test(JSON.stringify(x))));
const unread = await read([open1], [], { forgotten: async () => { throw new Error("db down"); } });
check("fails closed when the guards can't be read", unread.transitions!.length === 0 && unread.guardsUnread === true);
const noGuard = await MK.memberKnowledge("u1", { include: ["transitions"] }, { ...base([open1]), forgotten: undefined });
check("fails closed when there is no guard read at all", noGuard.transitions!.length === 0);
const strip = await read([row({ id: "m", text: "moving in with Maya's friend Maya Chen", quote: "moving in with Maya next month" })]);
check("the name strip applies to what Cue writes, and their own words are kept", !/friend/.test(strip.transitions![0].text) && /their details aren't kept/.test(strip.transitions![0].text) && strip.transitions![0].quote === "moving in with Maya next month");
check("the loader's failure gives an empty section, not a throw", (await read([], [], { transitions: async () => { throw new Error("x"); } })).transitions!.length === 0);

// ---------------------------------------------------------------- isolation: asserted on the SQL
const seen: { sql: string; args: unknown[] }[] = [];
await MK.loadTransitions("user-aaa", { query: async (sql, args) => (seen.push({ sql, args }), { rows: [] }) });
check("two queries, both bound to the member's id as $1", seen.length === 2 && seen.every((q) => q.args[0] === "user-aaa" && /user_id = \$1/.test(q.sql)));
check("the id is never in the SQL text", seen.every((q) => !q.sql.includes("user-aaa")));
check("the transitions query reads only transition rows of that member", /FROM member_threads WHERE user_id = \$1 AND transition_source IS NOT NULL/.test(seen[0].sql));
check("no query reads anyone else's rows (no unbounded member_threads or profile_corrections read)", seen.every((q) => /WHERE user_id = \$1/.test(q.sql)));

// ---------------------------------------------------------------- life_chapters untouched
const mk = src("services/memberKnowledge.ts");
const mig = src("db/migrations.ts");
check("life_chapters isn't read or written by the new code", !/life_chapters/.test(threadsSrc) && !/life_chapters/.test(mk.slice(mk.indexOf("export async function loadTransitions"), mk.indexOf("export const realKnowledgeDeps"))));
check("the migration only adds nullable columns to member_threads (no rewrite of existing rows)", /ALTER TABLE member_threads ADD COLUMN IF NOT EXISTS transition_source TEXT, ADD COLUMN IF NOT EXISTS transition_channel TEXT/.test(mig) && !/UPDATE member_threads SET transition/.test(mig));
check("the thread kind column keeps its meaning (thread or commitment)", /kind TEXT NOT NULL DEFAULT 'thread' CHECK \(kind IN \('thread', 'commitment'\)\)/.test(mig));

// ---------------------------------------------------------------- not rendered into any prompt yet
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith(".ts") ? [join(dir, f)] : []));
const readers = walk(root).filter((f) => !f.endsWith("services/memberKnowledge.ts") && /\.transitions\b|"transitions"/.test(readFileSync(f, "utf8")));
check("no other source file reads the transitions section (nothing renders it)", readers.length === 0);
check("the snapshot render does not mention transitions", !/transition/i.test(src("services/memberSnapshot.ts")));

console.log(`member transitions: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
