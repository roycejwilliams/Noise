// A search the member asked for that failed (not "nothing found"): Cue tells them once per failure streak (services/searchFailedNotice.ts,
// approved by Royce 2026-11-09), through the proactive path and the send-time read, in its own words. Model-free (the draft and the read
// are stubbed), no database (a stubbed pool), no outside calls:
//   npx tsx evals/sweepFind/searchFailedNotice.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
};
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const N = await import("../../src/services/searchFailedNotice.js");
const DS = await import("../../src/services/dailySweep.js");
const P = await import("../../src/harness/proactive.js");
const G = await import("../../src/harness/notifyGate.js");
const MF = await import("../../src/harness/momentFit.js");
const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
const { default: pool } = await import("../../src/db/db.js");

const U = "u-ellis";
const ZONE = "America/Los_Angeles";
const at = (iso: string) => new Date(`${iso}-08:00`);
const ASK = { kind: "ask" as const, id: "a-41", text: "a ceramics studio with open wheel time near Oakland" };
const GOAL = { kind: "goal" as const, id: "g-9", text: "find a cofounder for a climate startup" };
const day = (d: string, items: { kind: string; id: string; status: string }[]) => ({ day: d, items, trigger: null, action: "skip" });

// ---------------------------------------------------------------- 1. who gets one
{
  // Their own ask failed two days running (11-08, 11-09): one notice.
  const streaks = DS.failingStreaks("2026-11-09", ["ask:a-41", "goal:g-9"], [day("2026-11-08", [{ kind: "ask", id: "a-41", status: "error" }, { kind: "goal", id: "g-9", status: "error" }])]);
  const items = [{ ...ASK, days: streaks.get("ask:a-41")! }, { ...GOAL, days: streaks.get("goal:g-9")! }];
  const out = N.searchFailedNotices({ userId: U, day: "2026-11-09", zone: ZONE, items, failedMin: DS.SWEEP_FAILING_DAYS, now: at("2026-11-09T11:00:00") });
  check("explicit ask that failed: exactly one notice", out.length === 1 && out[0].type === "search_failed" && out[0].payload.askCheckinId === "a-41", out);
  check("a background goal that failed: nothing", !out.some((n) => /g-9/.test(n.targetKey)));
  check("the notice is keyed by its streak (the ask and its first day)", out[0].targetKey === "search_failed:a-41:2026-11-08", out[0].targetKey);
  check("its summary carries no words of theirs", out[0].summary === N.SEARCH_FAILED_SUMMARY && !/ceramics/.test(out[0].summary));
  check("good only until the end of their day ('this morning', 'tomorrow' stay true)", out[0].expiresAt!.getTime() === N.endOfTheirDay("2026-11-09", ZONE).getTime() && out[0].expiresAt!.getTime() > at("2026-11-09T11:00:00").getTime() && out[0].expiresAt!.getTime() < at("2026-11-10T00:00:00").getTime(), out[0].expiresAt);
  check("only a goal failing: nothing at all", N.searchFailedNotices({ userId: U, day: "2026-11-09", zone: ZONE, items: [{ ...GOAL, days: 4 }], failedMin: 2, now: at("2026-11-09T11:00:00") }).length === 0);
  check("past the end of their day: nothing (it would read wrong tomorrow)", N.searchFailedNotices({ userId: U, day: "2026-11-09", zone: ZONE, items: [{ ...ASK, days: 2 }], failedMin: 2, now: at("2026-11-09T23:30:00") }).length === 0);
}

// ---------------------------------------------------------------- 2. once per streak
{
  // Day 3 of the same streak: the same key as day 2, so enqueueCandidate (a row already sent, dropped or pending) never queues another.
  const s3 = DS.failingStreaks("2026-11-10", ["ask:a-41"], [day("2026-11-09", [{ kind: "ask", id: "a-41", status: "error" }]), day("2026-11-08", [{ kind: "ask", id: "a-41", status: "error" }])]);
  const d3 = N.searchFailedNotices({ userId: U, day: "2026-11-10", zone: ZONE, items: [{ ...ASK, days: s3.get("ask:a-41")! }], failedMin: 2, now: at("2026-11-10T11:00:00") });
  check("a second failure in the same streak: the same key (no second notice)", d3.length === 1 && d3[0].targetKey === "search_failed:a-41:2026-11-08", d3.map((n) => n.targetKey));
  check("enqueue never revives a sent, dropped or expired row (a key seen once stays once)", /if \(existing\.rows\[0\]\.status !== "pending"\) \{\n\s*await client\.query\("ROLLBACK"\);\n\s*return \{ queued: false \};/.test(src("harness/proactive.ts")));
  // A search that went through (11-10) ends the streak; failing again 11-11 and 11-12 is a new streak, a new key.
  const s5 = DS.failingStreaks("2026-11-12", ["ask:a-41"], [day("2026-11-11", [{ kind: "ask", id: "a-41", status: "error" }]), day("2026-11-10", [{ kind: "ask", id: "a-41", status: "searched" }]), day("2026-11-09", [{ kind: "ask", id: "a-41", status: "error" }])]);
  const d5 = N.searchFailedNotices({ userId: U, day: "2026-11-12", zone: ZONE, items: [{ ...ASK, days: s5.get("ask:a-41")! }], failedMin: 2, now: at("2026-11-12T11:00:00") });
  check("a new streak after a search went through: a new key (told again, once)", d5.length === 1 && d5[0].targetKey === "search_failed:a-41:2026-11-11", d5.map((n) => n.targetKey));
}

// ---------------------------------------------------------------- 3. failed is not nothing-found
{
  // Yesterday searched and found nothing ("searched"), today failed: one day, below the bar: no notice.
  const s = DS.failingStreaks("2026-11-09", ["ask:a-41"], [day("2026-11-08", [{ kind: "ask", id: "a-41", status: "searched" }])]);
  check("nothing found yesterday is not a failed day (the streak is 1)", s.get("ask:a-41") === 1);
  check("so no notice", N.searchFailedNotices({ userId: U, day: "2026-11-09", zone: ZONE, items: [{ ...ASK, days: s.get("ask:a-41")! }], failedMin: 2, now: at("2026-11-09T11:00:00") }).length === 0);
  check("send-time re-read: a later search that came back empty (searched) ends it", !N.stillFailed({ resolved_at: null, kind: "find" }, "searched").ok);
  check("send-time re-read: still failing goes on", N.stillFailed({ resolved_at: null, kind: "find" }, "error").ok);
  check("send-time re-read: a closed or gone ask ends it", !N.stillFailed({ resolved_at: new Date(), kind: "find" }, "error").ok && !N.stillFailed(null, "error").ok);
  check("the facts say it failed on Cue's side, never that nothing was found", /didn't go through/.test(N.searchFailedFacts({ askText: "x" }).what_happened) && /did not come back empty/.test(N.searchFailedFacts({ askText: "x" }).what_happened) && /Never say nothing was found/.test(N.SEARCH_FAILED_TASK));
  check("only the day's failures are flagged (status error), never an empty run", /const failedToday = items\.filter\(\(i\) => i\.status === "error"\);/.test(src("services/dailySweep.ts")));
}

// ---------------------------------------------------------------- 4. the normal proactive path and the send-time read
{
  const cls = G.candidateClass("search_failed", false, {});
  check("class: an optional check-in (never 'requested', which would skip the read)", cls === "checkin");
  check("send-time read: it is judged (momentFit) like any optional message", MF.momentFitApplies(cls, {}, { type: "search_failed" }));
  check("send-time read: not in a pull either way changes nothing unexpected (a pull of a check-in isn't read, as for every check-in)", !MF.momentFitApplies(cls, {}, { type: "search_failed", pulled: true }));
  check("the safety hold delays it (news about their ask)", P.SAFETY_HOLD_ALSO.has("search_failed"));
  check("never class-held on a hard day (the read hears the hard stretch instead)", !P.HOLD_WHILE_STRUGGLING.has("search_failed"));
  check("registered with a policy and a purpose", !!P.TYPE_POLICY.search_failed && !!proactiveRegistry.search_failed);
  check("wiring: the day's last failed retry queues it, for a 9am run only", /if \(last && base\.trigger !== "manual"\) await flagFailingAgain\(userId, base\.day, items, base\.zone, now\)/.test(src("services/dailySweep.ts")) && /N\.searchFailedNotices\(\{ userId, day, zone, items: repeated, failedMin: SWEEP_FAILING_DAYS, now \}\)/.test(src("services/dailySweep.ts")) && /enqueueCandidate\(n\)/.test(src("services/dailySweep.ts")));
}

// ---------------------------------------------------------------- 5. the draft: Cue's own words from the facts; re-read first
{
  const inner = (pool as any).query;
  let last = "error";
  let resolved: Date | null = null;
  (pool as any).query = async (s: string, a: any[] = []) => {
    const q = s.replace(/\s+/g, " ");
    if (/FROM ask_checkins WHERE id::text = \$1/.test(q)) return { rows: [{ resolved_at: resolved, kind: "find" }] };
    if (/decision = 'sweep\.daily'/.test(q)) return { rows: [{ items: [{ kind: "ask", id: "a-41", status: last }] }] };
    return { rows: [] };
  };
  const prompts: string[] = [];
  P.setProactiveModelForTests(async (p) => (prompts.push(p), "I tried looking for a ceramics studio with open wheel time near Oakland this morning, and my search didn't go through. I'll try again tomorrow."));
  const c: any = { id: "c1", userId: U, type: "search_failed", targetKey: "search_failed:a-41:2026-11-08", topicKey: null, summary: N.SEARCH_FAILED_SUMMARY, priority: 47, dueAt: new Date(), expiresAt: null, payload: { askCheckinId: "a-41", askText: ASK.text }, attempts: 0, createdAt: new Date() };
  const person: any = { firstName: "Ellis", timezone: ZONE };
  try {
    const r: any = await proactiveRegistry.search_failed.draft(c, person);
    check("draft: one message, from the model (no fixed sentence)", Array.isArray(r.messages) && r.messages.length === 1 && prompts.length === 1, r);
    check("draft: the facts it's given are what they asked for, that it failed, and that it'll be tried tomorrow", prompts[0].includes(ASK.text) && prompts[0].includes("didn't go through") && prompts[0].includes("tomorrow morning"));
    check("draft: one or two short sentences, no link", r.rules?.maxSentences === 2 && r.rules?.allowUrl === false);
    last = "searched";
    const s: any = await proactiveRegistry.search_failed.draft(c, person);
    check("draft: a later search went through (even empty): nothing goes", typeof s.skip === "string" && prompts.length === 1, s);
    last = "error"; resolved = new Date();
    const z: any = await proactiveRegistry.search_failed.draft(c, person);
    check("draft: the ask closed since: nothing goes", typeof z.skip === "string" && prompts.length === 1, z);
  } finally {
    (pool as any).query = inner;
    P.setProactiveModelForTests(null);
  }
}

console.log(`\nsearch failed notice: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
