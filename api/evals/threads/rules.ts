// Model-free checks for open threads, commitment follow-ups, the one-item
// companion check-in, the weekly reflection, and the membership lapse
// (Royce, 2026-09-22). No model, no DB.
//
//   npx tsx evals/threads/rules.ts
import "dotenv/config";
import { readFileSync } from "fs";
import {
  gateThreadChanges,
  userLinesFromTranscript,
  pickThreadForCheckin,
  type MemberThread,
  type OwnLine,
} from "../../src/harness/memberThreads.js";
import { gateReflection, type WeekFacts } from "../../src/harness/memberReflection.js";
import { nextLapseStep, lapseText, LAPSE } from "../../src/services/membershipLapse.js";
import { TYPE_POLICY } from "../../src/harness/proactive.js";
import { PROACTIVE_PURPOSE } from "../../src/harness/proactivePurpose.js";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const LA = "America/Los_Angeles";
const thread = (over: Partial<MemberThread> = {}): MemberThread => ({
  id: "t1",
  text: "Pitching the investor on Friday",
  openedQuote: "I pitch the investor on Friday",
  openedAt: "2026-09-22T18:00:00.000Z",
  status: "open",
  feeling: null,
  dueDate: null,
  nextStep: "check_in",
  kind: "thread",
  closedQuote: null,
  lastTouchedAt: "2026-09-22T18:00:00.000Z",
  ...over,
});
// Tuesday 2026-09-22, 11am Pacific.
const lines: OwnLine[] = [
  { at: "2026-09-22T18:00", text: "I pitch the investor on Friday, kind of nervous" },
  { at: "2026-09-22T18:05", text: "I'll send the deck to Maya by Friday" },
  { at: "2026-09-26T19:00", text: "the pitch went really well, they want a second meeting" },
];

// ---------------------------------------------------------------- call lines
{
  const t = "assistant: How did the pitch go?\nuser: It went fine honestly\nit was long though\nassistant: Glad to hear it.\nuser: yeah";
  const own = userLinesFromTranscript(t);
  check("call transcript: only the member's lines count as their words", own.length === 2 && own[0] === "It went fine honestly it was long though" && own[1] === "yeah");
  check("call transcript: Co's lines are never their words", !own.some((l) => /pitch go|Glad/.test(l)));
}

// ------------------------------------------------ threads close only on a quote
{
  const onFile = [thread()];
  const close = (quote: string, status: "resolved" | "changed" = "resolved") => gateThreadChanges([], [{ id: "t1", status, quote }], onFile, lines, LA).closed.length;
  check("closes with a newer quote of theirs", close("the pitch went really well") === 1);
  check("never closes on words they didn't say (Co's or invented)", close("glad the pitch went great") === 0);
  check("never closes on the quote that opened it", close("I pitch the investor on Friday") === 0);
  check("never closes on a too-short quote", close("went well") === 0);
  check("never closes a thread that isn't theirs / on file", gateThreadChanges([], [{ id: "other", status: "resolved", quote: "the pitch went really well" }], onFile, lines, LA).closed.length === 0);
  const older = [thread({ openedAt: "2026-09-27T00:00:00.000Z" })];
  check("never closes on a quote older than the thread", gateThreadChanges([], [{ id: "t1", status: "resolved", quote: "the pitch went really well" }], older, lines, LA).closed.length === 0);
  check("silence is not a close: no proposal, nothing closes", gateThreadChanges([], [], onFile, lines, LA).closed.length === 0);
}

// ------------------------------------------------ threads open only on a quote
{
  const open = (o: any, onFile: MemberThread[] = []) => gateThreadChanges([o], [], onFile, lines, LA).opened;
  check("opens from their own words", open({ text: "Pitching the investor on Friday", quote: "I pitch the investor on Friday" }).length === 1);
  check("never opens from words they didn't say", open({ text: "Raising a seed round", quote: "we are raising a seed round" }).length === 0);
  check("never opens a thread that doesn't match its quote", open({ text: "Moving to Austin next month", quote: "I pitch the investor on Friday" }).length === 0);
  check("a paraphrased label of their words still opens", open({ text: "Getting ready for the investor meeting", quote: "I pitch the investor on Friday" }).length === 1);
  check("never opens a duplicate of an open thread", open({ text: "Pitching the investor Friday", quote: "I pitch the investor on Friday" }, [thread()]).length === 0);
  const bad = open({ text: "Pitching the investor on Friday", quote: "I pitch the investor on Friday", nextStep: "sell_them_something" });
  check("an unknown next step falls back to check_in", bad[0]?.nextStep === "check_in");
}

// ------------------------------------------- follow-ups from dates they gave
{
  const [c] = gateThreadChanges([{ text: "Sending the deck to Maya", quote: "I'll send the deck to Maya by Friday", when: "Friday", commitment: true }], [], [], lines, LA).opened;
  check("their 'Friday' (said Tuesday 9/22) is Friday 9/25", c?.dueDate === "2026-09-25");
  check("a dated promise of theirs is a commitment (gets a follow-up)", c?.kind === "commitment");
  const [n] = gateThreadChanges([{ text: "Sending the deck to Maya", quote: "I'll send the deck to Maya by Friday", when: "October 3", commitment: true }], [], [], lines, LA).opened;
  check("a date that isn't in their words is never used", n?.dueDate === null && n?.kind === "thread");
  const spoken: OwnLine[] = [{ at: "2026-09-22T18:00", text: "currently we are wanting to host the event october tenth" }];
  const [sp] = gateThreadChanges([{ text: "Hosting their event", quote: "we are wanting to host the event october tenth", when: "october tenth" }], [], [], spoken, LA).opened;
  check("a spoken date from a call ('october tenth') is read as October 10", sp?.dueDate === "2026-10-10");
  check("a quoted word in the label still matches their words", gateThreadChanges([{ text: "leaning toward a 'block party' style event", quote: "pivot towards more of a block party" }], [], [], [{ at: "2026-09-22T18:00", text: "we've been trying to pivot towards more of a block party" }], LA).opened.length === 1);
  const [u] = gateThreadChanges([{ text: "Sending the deck to Maya", quote: "I'll send the deck to Maya", commitment: true }], [], [], lines, LA).opened;
  check("no date given, no commitment follow-up", u?.dueDate === null && u?.kind === "thread");
  const t = src("harness/memberThreads.ts");
  check("commitment follow-ups use the existing window_followup type", /type: "window_followup",\s*targetKey: `thread:\$\{threadId\}`/.test(t));
  check("closing a thread drops its pending follow-up", t.includes("target_key = $2 AND status = 'pending'`, [userId, `thread:${c.id}`]"));
  const w = src("agent/windowFollowUp.ts");
  check("commitment follow-up is about them, never a pitch", /No advice, no suggestions, no events, no offer to help, nothing Co will do/.test(w));
  check("commitment follow-up still has the invented-day check", /if \(mentionsUnknownDay\(text, p\.dates \?\? p\.label\)\) return null;/.test(w));
}

// ------------------------------------------- one item per check-in
{
  const today = "2026-09-27";
  const threads = [
    thread({ id: "a", nextStep: "remember", lastTouchedAt: "2026-09-01T00:00:00Z" }),
    thread({ id: "b", dueDate: "2026-10-10", lastTouchedAt: "2026-09-02T00:00:00Z" }),
    thread({ id: "c", lastTouchedAt: "2026-09-20T00:00:00Z" }),
    thread({ id: "d", status: "waiting", lastTouchedAt: "2026-09-10T00:00:00Z" }),
    thread({ id: "e", status: "resolved", lastTouchedAt: "2026-08-01T00:00:00Z" }),
  ];
  check("check-in picks one thread: least recently touched, not 'remember', not future-dated, not closed", pickThreadForCheckin(threads, today)?.id === "d");
  check("no thread open, no thread picked", pickThreadForCheckin([], today) === null);
  const cc = src("agent/companionCheckin.ts");
  check("the item is a single thing, never a list", /export type CompanionItem = \{ kind: "web"; name: string; url: string; reason: string \};/.test(cc) && /item\?: CompanionItem \| null/.test(cc));
  check("with an item, the text must carry its link", /mustIncludeAny: \[item!\.url\]/.test(cc) && /const carriesItem = Boolean\(item\) && text\.includes\(item!\.url\);/.test(cc));
  check("an item that doesn't help is left out, not forced", /If it wouldn't actually help with this, leave it out and offer nothing\./.test(cc));
  check("without an item, the check-in offers nothing", /Offer nothing: no events, no links, no suggestions\./.test(cc));
  check("the check-in never promises later work", /Never promise anything Co will do later\./.test(cc));
  const mt = src("harness/memberThreads.ts");
  check("a web item passes the grounding gate and the web budget first", /reserveWebSearch\(userId, "sweep"/.test(mt) && /if \(found && g\?\.pass\) item =/.test(mt));
  const jobs = src("jobs/index.ts");
  check("a pending companion check-in isn't rebuilt every hour (no repeated web lookups)", /type = 'companion' AND status = 'pending' LIMIT 1/.test(jobs));
}

// ------------------------------------------- weekly reflection
{
  const facts = (over: Partial<WeekFacts> = {}): WeekFacts => ({ sends: [], replies: 0, lastReplyAt: null, offerShare: null, threads: [thread()], ...over });
  check("reflection can only pick one of their own open threads", gateReflection({ move: "check_in", threadId: "someone-else", reasoning: "x" }, facts()).move.move === "hold");
  check("reflection picks a valid thread", gateReflection({ move: "check_in", threadId: "t1", reasoning: "x" }, facts()).move.threadId === "t1");
  check("reflection holds when a companion text this week went unanswered", gateReflection({ move: "check_in", threadId: "t1", reasoning: "x" }, facts({ sends: [{ type: "companion", purpose: "companion", at: "2026-09-24T17:00", message: "" }] })).move.move === "hold");
  check("a reply after it clears the hold", gateReflection({ move: "check_in", threadId: "t1", reasoning: "x" }, facts({ sends: [{ type: "companion", purpose: "companion", at: "2026-09-24T17:00", message: "" }], replies: 1, lastReplyAt: "2026-09-24T18:00" })).move.move === "check_in");
  const r = src("harness/memberReflection.ts");
  check("reflection queues through the daily pick (enqueueCandidate), never sends", r.includes("enqueueCandidate(") && !/sendblue|sendMessage|sendExempt/.test(r));
  check("reflection logs its reasoning as proactive.reflection", (r.match(/decision: "proactive\.reflection"/g) ?? []).length >= 2);
}

// ------------------------------------------- membership lapse
{
  const d = (s: string) => new Date(s);
  const close = d("2026-10-21T16:30:00Z");
  const now = d("2026-09-23T16:30:00Z");
  const step = (sent: (string | null)[], at: string) => nextLapseStep(sent.map((s) => (s ? d(s) : null)), d(at), close);
  check("clock starts with notice 1", JSON.stringify(step([null, null, null, null], now.toISOString())) === JSON.stringify({ enqueue: { step: 1, final: false } }));
  check("next notice waits a week after the last one actually went out", step(["2026-09-23T17:00:00Z", null, null, null], "2026-09-29T17:00:00Z") === null);
  check("then notice 2", JSON.stringify(step(["2026-09-23T17:00:00Z", null, null, null], "2026-09-30T17:00:00Z")) === JSON.stringify({ enqueue: { step: 2, final: false } }));
  check("the 4th is the final notice", JSON.stringify(step(["2026-09-23T17:00:00Z", "2026-09-30T17:00:00Z", "2026-10-07T17:00:00Z", null], "2026-10-14T17:00:00Z")) === JSON.stringify({ enqueue: { step: 4, final: true } }));
  check("never archived before the final notice went out", step(["2026-09-23T17:00:00Z", "2026-09-30T17:00:00Z", "2026-10-07T17:00:00Z", null], "2026-12-01T17:00:00Z")?.hasOwnProperty("archive") !== true);
  check("never archived within a week of the final notice", step(["2026-09-23T17:00:00Z", "2026-09-30T17:00:00Z", "2026-10-07T17:00:00Z", "2026-10-18T17:00:00Z"], "2026-10-22T17:00:00Z") === null);
  check("archived a week after the final notice", JSON.stringify(step(["2026-09-23T17:00:00Z", "2026-09-30T17:00:00Z", "2026-10-07T17:00:00Z", "2026-10-18T17:00:00Z"], "2026-10-25T17:00:00Z")) === JSON.stringify({ archive: true }));
  check("three weekly notices then a final one", LAPSE.nudges === 3 && LAPSE.stepGapDays === 7);
  const t1 = lapseText("Jordan", "Wednesday, October 21", false);
  const t4 = lapseText("Jordan", "Wednesday, October 21", true);
  check("every notice names the close date", t1.includes("Wednesday, October 21") && t4.includes("Wednesday, October 21"));
  check("notices have no em dash or exclamation", ![t1, t4].some((t) => /[—–!]/.test(t)));
  const m = src("services/membershipLapse.ts");
  check("team accounts never start the clock", /u\.lapse_exempt = false/.test(m) && /OR u\.lapse_exempt OR/.test(m));
  check("a reply of theirs stops the clock", /> u\.lapse_started_at, false\)/.test(m));
  check("closing archives (never deletes)", m.includes("archiveAccount(u.id)") && !/DELETE FROM users/i.test(m));
  check("notices go through the proactive harness (hours and caps apply)", m.includes('type: "membership_lapse"') && !/sendblue/.test(m));
  check("lapse notices are ops, weekly", PROACTIVE_PURPOSE.membership_lapse === "ops" && TYPE_POLICY.membership_lapse.typeGapDays === 6);
  const mig = src("db/migrations.ts");
  check("archive columns are in the shared migrations (production has them too)", /ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ/.test(mig) && /ADD COLUMN IF NOT EXISTS lapse_exempt BOOLEAN/.test(mig));
}

// ------------------------------------------- leak check: one member's threads never reach another
{
  const mt = src("harness/memberThreads.ts");
  const rf = src("harness/memberReflection.ts");
  const sqlTouchingThreads = [...mt.matchAll(/`[^`]*member_threads[^`]*`/g), ...rf.matchAll(/`[^`]*member_threads[^`]*`/g)].map((x) => x[0]);
  const ownerScoped = (q: string) => /user_id = \$\d|user_id = u\.id|t\.user_id = u\.id/.test(q) || /^`CREATE|^`SELECT u\.id FROM users u|^`INSERT INTO member_threads \(user_id,/.test(q);
  check("every query on member_threads is scoped to one member", sqlTouchingThreads.length > 0 && sqlTouchingThreads.every(ownerScoped));
  const intro = ["services/networkIntroNudge.ts", "services/matching.ts", "services/eventScoring.ts", "services/eventGuestMatchHandoff.ts", "harness/introConsent.ts"];
  check("no intro or matching code reads anyone's threads", intro.every((f) => !/memberThreads|member_threads/.test(src(f))));
  const cc = src("agent/companionCheckin.ts");
  check("the check-in never mentions another person", /Don't mention any other person\./.test(cc));
  check("a 'suggest someone' thread never names a person in the check-in (intros stay in the double opt-in flow)", /the check-in never names anyone/.test(mt) && !/network_introductions|relevance_edges/.test(mt));
}

console.log(`thread rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
