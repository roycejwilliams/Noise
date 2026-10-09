// Promise wiring after a call (#113), zero tokens: a promise Co makes on its own opens a look-out task of its own kind, with the
// member's words from just before it, never one naming another member, and never mistaken for a send or kept by any old text.
//   npx tsx evals/calls/promiseWiring.ts
const G = await import("../../src/harness/callGrounding.js");
const { COMMIT_PREFIX } = await import("../../src/services/callCommitments.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };

const transcript = `assistant: Hey Jordan, it's Co.
user: My open house got into Design Digest!
assistant: That's huge. And when something worth pointing out turns up before the open house, you'll hear from me.
user: Amazing. Ok, gotta run, bye!`;
const p = { what: "Keep an eye out for press or people worth pointing out before the November open house", quotes: ["And when something worth pointing out turns up before the open house, you'll hear from me."], asked: null, coveredBy: null };
const t = G.promiseThreadTask(p, G.theirLineBefore(transcript, p.quotes[0]));
check("a look-out is its own kind of task, outside the send-promise cap and checks", t.source === "lookout" && !t.goal.startsWith(COMMIT_PREFIX) && t.goal.startsWith(G.PROMISE_THREAD_PREFIX));
check(`its words are theirs from just before the promise, not their goodbye ("${t.theirWords}")`, /Design Digest/.test(t.theirWords) && !/gotta run/.test(t.theirWords));
check("with no line before it, the placeholder", G.promiseThreadTask(p, "").theirWords === "(said on a call)");
check("a look-out naming a member linked to them is never opened", G.namesAMember("Watch for a room where Jordan and Sarah could meet", ["Sarah"]) && !G.namesAMember("Watch for press before the open house", ["Sarah"]));
check("every keepable promise opens something", G.promiseOpens({ coveredBy: 3, asked: null }) === "task_from_call" && G.promiseOpens({ coveredBy: null, asked: "find me a caterer" }) === "their_ask" && G.promiseOpens({ coveredBy: null, asked: null }) === "promise_thread");
const { promiseCloseCheck } = await import("../../src/services/taskTurn.js");
const lookoutClose = await promiseCloseCheck({ goal: t.goal, theirWords: t.theirWords, createdAt: new Date().toISOString(), source: "lookout" } as any, [], { sentSince: async () => [], now: () => new Date() } as any);
check("a look-out is never held to the send-promise close check (it texts only when something real turns up)", lookoutClose.ok && /not a promise/.test(lookoutClose.why));
const { atPromiseCap } = await import("../../src/services/promises.js");
check("look-outs don't count toward the send-promise cap", !atPromiseCap([{ source: "lookout" }, { source: "lookout" }, { source: "lookout" }]));
const { goalBody } = await import("../../src/services/followThrough.js").then((m: any) => ({ goalBody: m.goalBody })).catch(() => ({ goalBody: null }));
if (goalBody) check("the look-out prefix is stripped where goals are compared", goalBody(t.goal) === p.what);
const task = "Find and compare caterer and photographer options for the November club open house, mid-range priced.";
check("the same subject in other words is the one commitment (caterer + photographer)", G.sameSubject("Look for a caterer who serves a meal rather than a spread, and a photographer who blends in", task));
check("a different look-out on the same call stays its own (press before the open house)", !G.sameSubject("Keep an eye out for press or people worth pointing out before the November open house", task));

const TT = await import("../../src/services/taskTurn.js");
const nothingYet = ["No luck yet on what I promised for this afternoon, I'll have it for you tomorrow morning.", "Nothing solid for this weekend yet. I'll have it for you tomorrow morning.", "Still digging on this, will have it later."];
const real = ["Here's the founder run this Saturday at 9am at the Golden Gate Bridge: lu.ma/x", "Two caterers that fit, both in Nopa."];
check("the two texts from Royce's call (and their kind) are progress reports, refused as task texts", nothingYet.every((t) => TT.NOTHING_YET.test(t)));
check("a real delivery isn't mistaken for one", real.every((t) => !TT.NOTHING_YET.test(t)));
const CO = await import("../../src/services/coTasks.js");
check("a promise's first text is its delivery, past the daily cap on updates", CO.mayText({ lastTextedAt: null, source: "promise" } as any, 2, new Date()).ok && !CO.mayText({ lastTextedAt: null, source: "ask" } as any, 2, new Date()).ok);

console.log(`promise wiring: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
