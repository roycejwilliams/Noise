// Promise wiring after a call (#113), zero tokens: a promise Co makes on its own opens a look-out task of its own kind, with the
// member's words from just before it, never one naming another member, and never mistaken for a send or kept by any old text.
//   npx tsx evals/calls/promiseWiring.ts
const G = await import("../../src/harness/callGrounding.js");
const { COMMIT_PREFIX } = await import("../../src/services/callCommitments.js");
import fs from "node:fs";
const require_ = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
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

const notReports = ["If you're not ready to commit, here are two options that hold till Friday.", "Still looking great for Saturday: Builders who Run, 9am.", "Registration is not yet open, but here's the page: https://lu.ma/x", "Still working on the vegan option, but here's the caterer: Nopa Kitchen.", "Found it: Builders who Run on Saturday. Still on it for the Sunday options."];
check(`real deliveries aren't progress reports: ${notReports.filter((t) => TT.progressReport(t, ["Builders who Run", "Nopa Kitchen"])).join(" | ") || "none"}`, notReports.every((t) => !TT.progressReport(t, ["Builders who Run", "Nopa Kitchen"])));
check("the real \"nothing yet\" texts still are", nothingYet.slice(0, 2).every((t) => TT.progressReport(t, ["Builders who Run"])));
const P = await import("../../src/services/callLlmProxy.js");
const kept = ["I texted you the link yesterday, did it come through?", "Check your texts later for the link.", "It's on its way to being a great weekend."];
check(`true lines about sends are kept: ${kept.filter((t) => P.stripSendClaim(t) !== t).join(" | ") || "none"}`, kept.every((t) => P.stripSendClaim(t) === t));
check("a now-claim is still dropped", P.stripSendClaim("I just sent it to you.") === null && P.stripSendClaim("It's on its way.") === null);
// A grouped call task closes only when every send on it is kept (review of #115).
const grouped = { goal: 'Keep your word from the call: "I\'ll text you the run link."', theirWords: "yes send it", createdAt: new Date(Date.now() - 3600_000).toISOString(), source: "promise", notes: [{ text: 'Also said on the call: "I\'ll text you the Tech Week list." Send it in the same message as the rest of this task.' }] };
const onlyFirst = await TT.promiseCloseCheck(grouped as any, ["https://lu.ma/run", "Here's the run for Saturday."], { sentSince: async () => [], now: () => new Date() } as any);
check(`a grouped task with only its first send done stays open (${onlyFirst.why.slice(0, 80)})`, !onlyFirst.ok);
const both = await TT.promiseCloseCheck(grouped as any, ["https://lu.ma/run", "Here's the run for Saturday, and the Tech Week list for the weekend.", "https://tech-week.com/sf"], { sentSince: async () => [], now: () => new Date() } as any);
check("with both sent, it closes", both.ok, both);
check("the post-call text never mentions promised work (the delivery is its own message)", !/that you'll text it to them/.test(require_("jobs/postCallFollowUp.ts")) && /never mention it here/.test(require_("jobs/postCallFollowUp.ts")));

console.log(`promise wiring: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
