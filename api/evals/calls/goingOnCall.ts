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
  if (/^INSERT INTO event_presence \(event_api_id, user_id, arrived_at, arrived_via\)/.test(q)) {
    const r = presence.get(key(p[0], p[1])) ?? {};
    if (r.arrived_at && !r.not_going_at) return { rows: [] };
    const isNew = !r.arrived_at;
    presence.set(key(p[0], p[1]), { ...r, arrived_at: r.arrived_at ?? new Date(), arrived_via: r.arrived_via ?? p[2], not_going_at: null });
    return { rows: [{ user_id: p[1], is_new: isNew }] };
  }
  if (/SELECT user_id, arrived_at, not_going_at, sharing_seen_at, location_stopped_at FROM event_presence WHERE event_api_id = \$1 AND user_id = ANY/.test(q)) {
    return { rows: (p[1] as string[]).filter((u) => presence.has(key(p[0], u))).map((u) => ({ user_id: u, sharing_seen_at: null, location_stopped_at: null, arrived_at: null, not_going_at: null, ...presence.get(key(p[0], u)) })) };
  }
  if (/FROM co_profiles cp JOIN users u/.test(q) && /u\.phone_number = ANY\(\$1::text\[\]\) OR LOWER\(u\.email\) = ANY\(\$2::text\[\]\)/.test(q)) return { rows: [{ user_id: JORDAN, first_name: "Jordan", phone_number: "+15550100001", email: "jordan@example.test", city: "San Francisco", goals: [], blockers: [], activity_preferences: [], intent: [] }] };
  if (/^SELECT \* FROM event_presence WHERE event_api_id = \$1 AND user_id = \$2/.test(q)) { const r = presence.get(key(p[0], p[1])); return { rows: r ? [r] : [] }; }
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
check("their Noise event today: one section, the event named, and its JSON key", withToday.includes(`\n8. noise_event: they're on the list for Cue's Noise event today, "Founders Table". going: "no" only when the person says THEY themselves can't make it or didn't. Never for someone else ("my friend can't make it"), never for a condition or maybe ("might not", "if work runs late", "probably not"). "yes" only if they themselves said they're going after all. Otherwise null. quote: their exact words that say it, copied from their line.`) && /"noise_event": \{"going": null, "quote": null\}/.test(withToday));
check("the item after it is numbered on (already_know 9)", /\n9\. already_know: /.test(withToday) && /\n8\. already_know: /.test(without));
const withBoth = CL.callLearningPrompt({ ...base, going: today, introduced: ["Ellis"] });
check("with introductions on file too: introductions 8, going 9, already_know 10", /\n8\. introductions: /.test(withBoth) && /\n9\. noise_event: /.test(withBoth) && /\n10\. already_know: /.test(withBoth));
check("a no-show question still open: only a no is asked for", /which Cue asked whether they made it to\. going: "no" only when the person says THEY themselves/.test(CL.goingSection(8, noshow)) && /\. Otherwise null\./.test(CL.goingSection(8, noshow)) && !/going after all/.test(CL.goingSection(8, noshow)));
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
{
  const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
  const cand: any = { id: "c1", userId: JORDAN, type: "pre_arrival", payload: { eventId: EV, name: "Founders Table", startAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), timezone: "America/Los_Angeles", canUseLocation: false, until: new Date(Date.now() + 2 * 3_600_000).toISOString() }, createdAt: new Date() };
  const d: any = await (proactiveRegistry as any).pre_arrival.draft(cand, { firstName: "Jordan", timezone: "America/Los_Angeles" });
  check("a pre-arrival text already queued: its draft reads the call's no and nothing goes", d && "skip" in d && /can't make it/.test(d.skip), d);
}
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

// ---------------------------------------------------------------- 3b. a false "no" never counts (review of #380)
const reads = (line: string, quote: string, going = "no") => CL.readCallGoing(said(going, quote), `assistant: Still on for tonight?\nuser: ${line}`, today);
let rd = reads("My friend Sam can't make it tonight, so I'm flying solo", "can't make it tonight");
check("\"My friend Sam can't make it tonight, so I'm flying solo\": someone else, doesn't count", rd.going === null && rd.why === "not_them", rd);
rd = reads("If work runs late I might not make it", "I might not make it");
check("\"If work runs late I might not make it\": a condition, doesn't count", rd.going === null && rd.why === "hedged", rd);
rd = reads("probably not going to make it", "not going to make it");
check("\"probably not going to make it\": a maybe, doesn't count", rd.going === null && rd.why === "hedged", rd);
rd = reads("I can't make it tonight", "I can't make it tonight");
check("\"I can't make it tonight\": still counts", rd.going === false && rd.why === null, rd);
check("more of the same: she/they/a name/my partner, or maybe, possibly, not sure, may, could: none count", [
  reads("She can't make it tonight", "can't make it tonight"), reads("They won't make it, they're sick", "won't make it"), reads("Ellis can't make it", "can't make it"),
  reads("My partner can't come tonight", "can't come tonight"), reads("Maybe I can't make it", "I can't make it"), reads("I possibly can't make it", "can't make it"),
  reads("Not sure, I can't make it maybe", "I can't make it"), reads("I may not make it tonight", "may not make it"), reads("I could miss it tonight, not make it", "not make it"),
].every((r) => r.going === null), "");
check("a firm no in the past tense still counts (couldn't is not could)", reads("Sorry, I couldn't make it last night", "I couldn't make it").going === false);
check("going after all, about themself: counts; about someone else: doesn't", reads("Good news, I'm coming after all", "I'm coming after all", "yes").going === true && reads("My friend is coming after all", "is coming after all", "yes").going === null);
presence.clear();
const decisions: any[] = [];
const realQ = (pool as any).query;
(pool as any).query = async (sql: string, p: any[] = []) => { if (/INSERT INTO harness_decisions/.test(sql)) decisions.push(p); return realQ(sql, p); };
await CL.saveCallGoing(JORDAN, said("no", "can't make it tonight"), "user: My friend Sam can't make it tonight, so I'm flying solo", today);
(pool as any).query = realQ;
check("turned down: nothing recorded", !presence.has(key(EV, JORDAN)));
check("…and one decision, saying why in a word, with none of their words", decisions.length === 1 && decisions[0].includes("not_them") && !JSON.stringify(decisions[0]).match(/Sam|friend|flying|tonight/), decisions);

// ---------------------------------------------------------------- 3c. arrival puts them back in the room
presence.clear();
await CL.saveCallGoing(JORDAN, said("no", "I can't make it tonight"), call, today);
const E = await import("../../src/services/eventScoring.js");
const guests: any[] = [{ approval_status: "approved", email: "jordan@example.test", phone: "+15550100001", name: "Jordan" }];
check("a call's no: out of the room", !!presence.get(key(EV, JORDAN))?.not_going_at && (await E.inRoomPool(EV, guests)).length === 0);
const PR = await import("../../src/services/eventPresence.js");
const first = await PR.markArrived(EV, JORDAN, "location");
check("then they arrive: the no is cleared, the arrival is new, and they're back in the pool", first === true && presence.get(key(EV, JORDAN))?.not_going_at === null && !!presence.get(key(EV, JORDAN))?.arrived_at && (await E.inRoomPool(EV, guests)).map((g) => g.user_id).join() === JORDAN);
check("arriving again is not a new arrival", (await PR.markArrived(EV, JORDAN, "text")) === false);
await P.recordGoing(JORDAN, false, today);
check("a later no after arriving, then arrival evidence again: cleared again, not a new arrival", (await PR.markArrived(EV, JORDAN, "text")) === false && presence.get(key(EV, JORDAN))?.not_going_at === null);

// ---------------------------------------------------------------- 4. wiring
const cl = src("services/callLearning.ts");
const ct = src("agent/conversationTools.ts");
check("learnFromCall reads the subject once, puts it in the prompt, and saves through saveCallGoing", /const goingSubj = await import\("\.\/preArrival\.js"\)\.then\(\(P\) => P\.goingSubject\(input\.userId, null\)\)/.test(cl) && /going: goingSubj,/.test(cl) && /await saveCallGoing\(input\.userId, raw, input\.transcript, goingSubj\)/.test(cl));
check("the text tool uses the same subject and record", /P\.goingSubject\(ctx\.userId, going\)/.test(ct) && /P\.recordGoing\(ctx\.userId, going, subject\)/.test(ct));
check("GPT-Live's post-call runs learnFromCall (the read this changes)", /await learnFromCall\(\{ userId: user_id, transcript: cleanTranscript/.test(src("routes/co.ts")));

console.log(`going on a call: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
