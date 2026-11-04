// "Can't make it tonight" said on a call is recorded like a text (Royce, 2026-11-03). The call's after-call read (services/callLearning.ts)
// gets a going section only when they're on the list for a Noise event today, or their "did you make it?" is still open; its answer,
// checked against their own lines, goes through the text tool's own record (services/preArrival.ts recordGoing), so the brief, the
// pre-arrival text and the no-show flow read it the same way. Layer 1: a fake store, zero tokens, nothing sent. Invented members.
//   npx tsx evals/calls/goingOnCall.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const JORDAN = "00000000-0000-4000-8000-0000000000a1";
const EV = "evt-founders-table";

// ---------------------------------------------------------------- the fake store: event_presence
const presence = new Map<string, any>();
const key = (e: string, u: string) => `${e}|${u}`;
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async (sql: string, p: any[] = []) => {
  const q = sql.replace(/\s+/g, " ");
  const set = q.match(/^INSERT INTO event_presence \(event_api_id, user_id, not_going_at\) VALUES \(\$1, \$2, (NULL|NOW\(\))\)/);
  if (set) {
    const r = presence.get(key(p[0], p[1])) ?? {};
    presence.set(key(p[0], p[1]), { ...r, not_going_at: set[1] === "NULL" ? null : new Date() });
    return { rows: [] };
  }
  if (/SELECT name_asked_at, name_ok, brief_sent_at, not_going_at FROM event_presence WHERE event_api_id = \$1 AND user_id = \$2/.test(q)) {
    const r = presence.get(key(p[0], p[1]));
    return { rows: r ? [{ name_asked_at: null, name_ok: null, brief_sent_at: null, ...r }] : [] };
  }
  if (/INSERT INTO harness_decisions/.test(q)) return { rows: [{ id: "1", created_at: new Date() }] };
  return { rows: [] };
};
const CL = await import("../../src/services/callLearning.js");
const P = await import("../../src/services/preArrival.js");
const B = await import("../../src/services/eventBrief.js");
const N = await import("../../src/services/eventNoShow.js");
const CF = await import("../../src/services/eventCheckinFollowUp.js");

const today = { eventApiId: EV, name: "Founders Table", kind: "today" as const };
const noshow = { eventApiId: EV, name: "Founders Table", kind: "noshow" as const };
const call = "assistant: Are you still coming to Founders Table tonight?\nuser: Ugh, I can't make it tonight, something came up at work.\nassistant: No problem at all.";
const said = (going: string, quote: string) => ({ noise_event: { going, quote } });

// ---------------------------------------------------------------- 1. the prompt: only when it applies, and minimal
const base = { transcript: call, today: "2026-11-04", onFile: null, openAsks: [] };
const without = CL.callLearningPrompt(base);
const withToday = CL.callLearningPrompt({ ...base, going: today });
check("no Noise event today and no open question: the prompt has no going section", !/noise_event/.test(without));
check("their Noise event today: one section, the event named, and its JSON key", /\n8\. noise_event: they're on the list for Cue's Noise event today, "Founders Table"\. going: "no" only if the person said outright they can't make it or didn't make it, "yes" only if they said they're going after all, else null\. quote: their exact words that say it, copied from their line\./.test(withToday) && /"noise_event": \{"going": null, "quote": null\}/.test(withToday));
check("the item after it is numbered on (already_know 9)", /\n9\. already_know: /.test(withToday) && /\n8\. already_know: /.test(without));
const withBoth = CL.callLearningPrompt({ ...base, going: today, introduced: ["Ellis"] });
check("with introductions on file too: introductions 8, going 9, already_know 10", /\n8\. introductions: /.test(withBoth) && /\n9\. noise_event: /.test(withBoth) && /\n10\. already_know: /.test(withBoth));
check("a no-show question still open: only a no is asked for", /which Cue asked whether they made it to\. going: "no" only if .* didn't make it, else null\./.test(CL.goingSection(8, noshow)) && !/going after all/.test(CL.goingSection(8, noshow)));
check("the rest of the prompt is the same with or without it", without === withToday.replace(CL.goingSection(8, today), "").replace("\n9. already_know: ", "\n8. already_know: ").replace(`,\n "noise_event": {"going": null, "quote": null}`, ""));

// ---------------------------------------------------------------- 2. the answer: their own words only
check("their no, in their own words: recorded as not going", CL.callGoingFrom(said("no", "I can't make it tonight"), call, today) === false);
check("a quote that is Cue's words, not theirs: nothing", CL.callGoingFrom(said("no", "Are you still coming"), call, today) === null);
check("too short a quote: nothing", CL.callGoingFrom(said("no", "Ugh"), call, today) === null);
check("an answer that isn't yes or no: nothing", CL.callGoingFrom(said("maybe", "I can't make it tonight"), call, today) === null && CL.callGoingFrom({}, call, today) === null);
check("a yes to a no-show question isn't a going (an arrival is markArrived's): nothing", CL.callGoingFrom(said("yes", "I can't make it tonight"), call, noshow) === null);
check("no event to be about: nothing", CL.callGoingFrom(said("no", "I can't make it tonight"), call, null) === null);

// ---------------------------------------------------------------- 3. through the record every reader uses
presence.clear();
let r = await CL.saveCallGoing(JORDAN, said("no", "I can't make it tonight"), call, today);
check("call: saved through recordGoing on their presence row", r.going === false && r.recorded?.eventApiId === EV && !!presence.get(key(EV, JORDAN))?.not_going_at, { r, row: presence.get(key(EV, JORDAN)) });
const flags = await B.presenceFlags(EV, JORDAN);
check("the member brief reads it: not going, so no brief", flags.notGoing && !B.briefEligible({ registered: true, notGoing: flags.notGoing, alreadySent: false, eventListed: true }).ok);
check("the pre-arrival text reads it: not eligible", !P.preArrivalEligible({ registered: true, notGoing: flags.notGoing, alreadySent: false, eventListed: true }).ok);
check("the end-of-night debrief reads it: skipped (the no-show flow has the night)", CF.debriefForPresence({ not_going_at: presence.get(key(EV, JORDAN)).not_going_at }, false) === "skip");
check("the no-show ask is never sent to someone who said no (its own skip)", /if \(r\?\.noshow_asked_at \|\| r\?\.not_going_at\) continue;/.test(src("services/eventNoShow.ts")));
presence.clear();
const asked = new Date(Date.now() - 60_000);
r = await CL.saveCallGoing(JORDAN, said("no", "I can't make it tonight"), call, noshow);
check("call, after the ask: a no settles the no-show question as said no (the sorry note follows)", r.recorded?.kind === "noshow" && N.verdict(false, { asked_at: asked, not_going_at: presence.get(key(EV, JORDAN))?.not_going_at ?? null, last_inbound_at: new Date() }) === "said_no");
presence.clear();
await CL.saveCallGoing(JORDAN, said("no", "Are you still coming"), call, today);
check("call: a quote that isn't theirs writes nothing", !presence.has(key(EV, JORDAN)));
presence.clear();
const viaText = await P.recordGoing(JORDAN, false, today);
check("text: the tool's record is the same function and the same row", viaText?.eventApiId === EV && !!presence.get(key(EV, JORDAN))?.not_going_at);
presence.clear();
check("a yes after the night is never written as going", (await P.recordGoing(JORDAN, true, noshow)) === null && !presence.has(key(EV, JORDAN)));
await P.recordGoing(JORDAN, false, today);
await CL.saveCallGoing(JORDAN, said("yes", "I'm coming after all"), "assistant: Sorry you can't make it.\nuser: Good news, the meeting moved, I'm coming after all.", today);
check("going after all, said on a call: the row clears", presence.get(key(EV, JORDAN))?.not_going_at === null);

// ---------------------------------------------------------------- 4. wiring
const cl = src("services/callLearning.ts");
const ct = src("agent/conversationTools.ts");
check("learnFromCall reads the subject once, puts it in the prompt, and saves through saveCallGoing", /const goingSubj = await import\("\.\/preArrival\.js"\)\.then\(\(P\) => P\.goingSubject\(input\.userId, null\)\)/.test(cl) && /going: goingSubj,/.test(cl) && /await saveCallGoing\(input\.userId, raw, input\.transcript, goingSubj\)/.test(cl));
check("the text tool uses the same subject and record", /P\.goingSubject\(ctx\.userId, going\)/.test(ct) && /P\.recordGoing\(ctx\.userId, going, subject\)/.test(ct));
check("GPT-Live's post-call runs learnFromCall (the read this changes)", /await learnFromCall\(\{ userId: user_id, transcript: cleanTranscript/.test(src("routes/co.ts")));

console.log(`going on a call: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
