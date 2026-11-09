// One flow, rechecked before optional delivery (Royce, 2026-11-09): the text after a call is judged like any optional message, the read
// sees Cue's other waiting messages and the hard day, a stale or duplicate message doesn't go, and a correction Cue owes is never judged
// away. Layer 1: the read's model stubbed through its own seam, synthetic members, no database, no network.
//   npx tsx evals/followThrough/momentFollowThrough.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const MF = await import("../../src/harness/momentFit.js");
const { candidateClass } = await import("../../src/harness/notifyGate.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); } };

const now = new Date("2026-11-09T19:00:00Z");
const ready = { ready: true as const, line: "[Mon 10:30am] Call: Jordan weighed two offers, a climate startup and a design firm; the firm wants an answer by month's end." };
const base = { userId: "00000000-0000-0000-0000-000000000000", firstName: "Jordan", queuedAt: new Date(now.getTime() - 40 * 60_000), now };

// ---------------------------------------------------------------- 1. the post-call text is optional now; its obligations aren't
{
  check("the text after a call goes to the read (it's Cue's own next thought, not something they asked for)", MF.momentFitApplies(candidateClass("post_call", false, {}), {}, { type: "post_call" }));
  check("a pulled one, or a held recap, isn't read", !MF.momentFitApplies("requested", {}, { type: "post_call", pulled: true }) && !MF.momentFitApplies("requested", { recapHeldAt: "2026-11-08T00:00:00Z" }, { type: "post_call" }));
  check("a post-call text carrying a correction Cue owes is not optional: never judged away", MF.carriesCallCorrection("post_call", { callCorrectionIds: ["c1"] }) && !MF.carriesCallCorrection("post_call", {}) && !MF.carriesCallCorrection("companion", { callCorrectionIds: ["c1"] }));
  const p = src("harness/proactive.ts");
  check("the dispatch skips the read for that draft, and the send lock follows the read actually made", /const momentRead = moment\.applies && !STR\.carriesCallCorrection\(c\.type, "meta" in draft \? draft\.meta : null\);/.test(p) && /const judgedAt: Date \| null = momentRead \? contextAt : null;/.test(p));
  check("requested reminders, promises' deliveries and obligations still keep their own timing", ["direct_ask", "task_update", "commitment_nudge", "deadline_nudge", "call_reminder"].every((t) => !MF.momentFitApplies(candidateClass(t, false, {}), {}, { type: t })) && !MF.momentFitApplies("checkin", { kind: "commitment" }, { type: "window_followup" }) && !MF.momentFitApplies("checkin", {}, { type: "ask_checkin" }));
}

// ---------------------------------------------------------------- 2. the read's prompt: what's waiting, the hard day, the post-call line
{
  const prompt = MF.momentPrompt({ ...base, message: "x", recent: "[Mon 10:40am] User said: thanks", call: ready.line, kind: "post_call", queued: ["Mark a moment in their story: went to the climate meetup"], hardDay: true });
  check("the read is told this is the text after a call, and that a call ending isn't a reason on its own", prompt.includes(MF.POST_CALL_LINE) && /not a reason on its own to text/.test(MF.POST_CALL_LINE));
  check("the read sees Cue's other messages waiting for them", /Cue's other messages waiting to go to them \(not sent\):\n- Mark a moment in their story/.test(prompt));
  check("a failed queue read is said as unknown, never as nothing waiting", MF.momentPrompt({ ...base, message: "x", recent: "", call: null, queued: null }).includes(MF.QUEUED_UNREAD));
  check("the weigh line asks about repeats and what it adds that they don't already have", /does it repeat what Cue already said or something waiting above/.test(prompt) && /what specific thing does it add now that they don't already have/.test(prompt));
  check("the hard day reaches every message the read covers, as care, not a verdict", MF.momentHardDay({ kind: "post_call", hardDay: true }) && MF.momentHardDay({ kind: "companion", hardDay: true }) && !MF.momentHardDay({ kind: "companion", hardDay: false }) && prompt.includes(MF.HARD_DAY_LINE));
  const plain = MF.momentPrompt({ ...base, message: "x", recent: "", call: null, kind: "companion" });
  check("a check-in's read has no post-call line and no hard-day line when the day isn't hard", !plain.includes(MF.POST_CALL_LINE) && !plain.includes(MF.HARD_DAY_LINE));
}

// ---------------------------------------------------------------- 3. a worthwhile later contribution goes
{
  const prompts: string[] = [];
  MF.setMomentModelForTests(async (p) => (prompts.push(p), '{"verdict":"send","why":"they asked what Cue would do and the call ended before an answer"}'));
  const v = await MF.momentFit({ ...base, message: "If the startup is the work you care about, I'd ask them for runway in writing before you answer the firm.", recent: "[Mon 10:40am] User said: thanks, gotta run", call: ready, kind: "post_call", queued: [] });
  MF.setMomentModelForTests(null);
  check("a take on a decision the call left open is sent", MF.momentAction(v, { waits: 0 }, now).act === "send", v);
  check("the read saw the call, their text since, the post-call line and an empty queue", /two offers/.test(prompts[0]) && /gotta run/.test(prompts[0]) && prompts[0].includes(MF.POST_CALL_LINE) && /\(nothing else\)/.test(prompts[0]));
}

// ---------------------------------------------------------------- 4. venting: a pushed solution after they only wanted to be heard is dropped
{
  MF.setMomentModelForTests(async () => '{"verdict":"drop","why":"they said they did not need fixing; advice now would push a solution"}');
  const v = await MF.momentFit({ ...base, firstName: "Noor", message: "Have you tried a hiring rubric you both sign off on before the next round?", recent: "[Mon 10:40am] User said: I don't need fixing, I just needed to say it", call: ready, kind: "post_call", queued: [] });
  MF.setMomentModelForTests(null);
  const a = MF.momentAction(v, { waits: 0 }, now);
  check("the read's drop closes it: nothing goes, with the reason recorded", a.act === "drop" && /need fixing/.test((a as { why: string }).why), a);
}

// ---------------------------------------------------------------- 5. stale or duplicate: never sent
{
  const prompts: string[] = [];
  MF.setMomentModelForTests(async (p) => (prompts.push(p), '{"verdict":"drop","why":"Cue already said this in its reply an hour ago"}'));
  const dup = await MF.momentFit({ ...base, message: "I'd ask for runway in writing.", recent: "[Mon 11:10am] Co replied: I'd ask them for runway in writing before you answer.", call: ready, kind: "post_call", queued: ["Short text about one specific thing they said on a call 1h ago"] });
  MF.setMomentModelForTests(null);
  check("a take Cue already gave in a reply since is dropped (no repeats, one flow)", MF.momentAction(dup, { waits: 0 }, now).act === "drop" && /runway in writing before you answer/.test(prompts[0]));
  const notReady = await MF.momentFit({ ...base, message: "x", recent: "", call: { ready: false, why: "the call that just ended isn't summarized yet" }, kind: "post_call" });
  check("call context not ready is never treated as empty: it waits for it, counted toward nothing", notReady.read === "call_not_ready" && MF.momentAction(notReady, { waits: 0 }, now).act === "wait");
  const unread = await MF.momentFit({ ...base, message: "x", recent: null, call: ready, kind: "post_call" });
  check("their texts unreadable: it waits, never sends", unread.verdict === "wait" && unread.read === "no_context");
  check("waiting is never endless: past its waits, an optional message is dropped", MF.momentAction({ verdict: "wait", why: "later", read: "model" }, { waits: MF.MOMENT_FIT.maxWaits }, now).act === "drop");
  const db = { query: async () => ({ rows: [{ x: 1 }] }) };
  check("anything of theirs after the judgment makes it stale: the send lock holds it", (await MF.momentStillCurrent(db, base.userId, now)) === false);
  const failing = { query: async () => { throw new Error("down"); } };
  check("the queue read failing is null (said as unknown), never an empty list", (await MF.loadQueuedFor(failing, base.userId, "1")) === null);
  const q = await MF.loadQueuedFor({ query: async (sql: string, args: unknown[]) => { check("the queue read is owner-scoped and leaves the judged message out", /WHERE user_id = \$1 AND status = 'pending' AND id::text <> \$2/.test(sql) && args[0] === base.userId && args[1] === "7"); return { rows: [{ type: "companion", summary: "Weekly reflection:  check in on \"the move\"" }] }; } }, base.userId, "7");
  check("waiting messages read as their one-line summaries", q?.[0] === 'Weekly reflection: check in on "the move"', q);
}

console.log(`moment follow-through: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
