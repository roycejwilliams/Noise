// The ask check-in's frame (agent/askCheckin.ts; context-across-cue-plan.md item 4, Stage 1 #13 / fix 6): no quoted example in
// the task (drafts copied it: "Still ..., or has that shifted?" four times in six days), and Cue's last 3 ask check-ins shown as
// frames not to reuse. Layer 1: stub model and a fake database, zero tokens.   npx tsx evals/checkins/askFrame.ts
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import { readFileSync } from "node:fs";
const A = await import("../../src/agent/askCheckin.js");
const P = await import("../../src/harness/proactive.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const QUOTED = /\("[^"]+\?"\)|Still looking for Series A operators/;
const RECENT = [
  "Still on the hunt for an advisor who's done a pre-seed raise, or has what you need shifted?",
  "Still want the positioning doc redone, or has that shifted?",
  "Still looking for someone who's run a supper club, or has that changed?",
  "An older one that shouldn't show",
];

// ---- the task
const first = A.askCheckinTask({ checkinCount: 0 });
check("first check-in task: no quoted example frame", !QUOTED.test(first) && /naming it in plain words/.test(first) && /return SKIP/.test(first));
check("escalated task: no quoted example frame either", !QUOTED.test(A.askCheckinTask({ checkinCount: 3 })) && /checked in on this 3 times/.test(A.askCheckinTask({ checkinCount: 3 })));
const withRecent = A.askCheckinTask({ checkinCount: 1 }, RECENT);
check("recent check-ins are in the task, as frames not to reuse, at most 3", /don't reuse their opening or their shape/.test(withRecent) && RECENT.slice(0, 3).every((r) => withRecent.includes(r)) && !withRecent.includes(RECENT[3]));
check("each recent line is one line, at most 200 characters", A.askCheckinTask({ checkinCount: 0 }, [`a\n${"x".repeat(400)}`]).split("\n").filter((l) => l.startsWith("- ")).every((l) => l.length <= 205 && !/\n/.test(l)));
check("no recent check-ins: the task as before, with nothing added", A.askCheckinTask({ checkinCount: 0 }, []) === first);

// ---- the prompt the model gets
let prompt = "";
P.setProactiveModelForTests(async (p: string) => { prompt = p; return "Is an advisor still what you want, or has the need moved?"; });
const out = await A.draftAskCheckin("Ellis", { askCheckinId: "k1", askId: "a1", askText: "an advisor who's done a pre-seed raise", checkinCount: 1, hasMatches: false }, RECENT.slice(0, 3));
P.setProactiveModelForTests(null as any);
check("the draft's prompt has no quoted example and has the recent check-ins", !QUOTED.test(prompt) && RECENT.slice(0, 3).every((r) => prompt.includes(r)));
check("the recent check-ins are not stated as confirmed facts", (() => { const f = prompt.slice(prompt.indexOf("CONFIRMED_FACTS"), prompt.indexOf("TASK")); return !RECENT.some((r) => f.includes(r)); })());
check("the draft still returns with its rules", !!out && out.rules.maxSentences === 2 && out.rules.maxChars === 260);

// ---- reading the recent ones
const U = "00000000-0000-4000-8000-0000000e1119";
let asked = "";
const fakeQ = (messages: string[], corrections: any[] = []) => ({
  query: async (sql: string) => {
    if (/FROM proactive_sends/.test(sql)) { asked = sql; return { rows: messages.map((message) => ({ message })) }; }
    if (/FROM profile_corrections/.test(sql)) return { rows: corrections };
    return { rows: [] };
  },
});
const got = await A.recentAskCheckins(U, fakeQ(RECENT.slice(0, 3)));
check("recentAskCheckins: this member's ask check-ins only, newest first, 3", got.length === 3 && /user_id = \$1 AND type = 'ask_checkin'/.test(asked) && /ORDER BY sent_at DESC LIMIT 3/.test(asked));
const removal = { field: "claim", old_value: "the custody hearing in May", new_value: null, item_ref: "claim:1a2b3c4d", removed: "true" };
const guarded = await A.recentAskCheckins(U, fakeQ(["Still prepping for the custody hearing in May, or has that passed?", RECENT[0]], [removal]));
check("recentAskCheckins: a check-in that says something they had Cue forget isn't shown again; the other is", guarded.length === 1 && guarded[0] === RECENT[0]);
check("recentAskCheckins: a failed read is none", (await A.recentAskCheckins(U, { query: async () => { throw new Error("db down"); } })).length === 0);
const guardDown = await A.recentAskCheckins(U, { query: async (sql: string) => { if (/FROM proactive_sends/.test(sql)) return { rows: [{ message: "Still prepping for the custody hearing in May, or has that passed?" }] }; throw new Error("guard read failed"); } });
check("recentAskCheckins: a failed guard read is none (fails closed), never the unguarded lines", guardDown.length === 0);

// ---- wiring
check("wiring: the registry passes the recent check-ins, after the send-time gate", /if \(!gate\.ok\) return skip\(gate\.why\);\s*const r = await draftAskCheckin\(person\.firstName, c\.payload as AskCheckinPayload, await recentAskCheckins\(c\.userId\)\);/.test(src("harness/proactiveRegistry.ts")));

console.log(`ask check-in frame: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
