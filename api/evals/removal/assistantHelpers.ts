// The general-assistant helpers are gone (Royce, 2026-11-04). Zero tokens, no DB.
//   - the calendar file exists only for a member going to a Noise event, with the right instant; a plan request gets none
//   - Cue doesn't accept a task for drafting their email (text or call), and the call sheet says so
//   - nothing offers a sheet, a brief or a venue_brief document
//   - the Gmail cleanup script does nothing without --apply, and --dry-run prints counts only
//   npx tsx evals/removal/assistantHelpers.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const EC = await import("../../src/services/eventCalendar.js");
const Cap = await import("../../src/services/capabilities.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const NOW = new Date("2026-11-10T20:00:00Z");

// ---- going to a Noise event: a calendar file with the right time and timezone
const sent: any[] = [];
const deps = (email: string | null, ev: any) => ({ loadEvent: async () => ev, loadEmail: async () => email, send: async (o: any) => (sent.push(o), true), now: () => NOW });
const EVENT = { id: "evt-1", name: "Founders Dinner", startAt: "2026-11-11T19:00:00-08:00", endAt: "2026-11-11T22:00:00-08:00", timezone: "America/Los_Angeles", venue: "The Battery", address: "717 Battery St, San Francisco", url: "https://lu.ma/fd" };
const ics = EC.buildEventIcs(EVENT, NOW)!;
check("the file is a calendar with one event", /BEGIN:VCALENDAR/.test(ics) && (ics.match(/BEGIN:VEVENT/g) ?? []).length === 1 && /END:VCALENDAR\r\n$/.test(ics));
check("7pm Pacific is 03:00 UTC the next day, and ends three hours later", /DTSTART:20261112T030000Z/.test(ics) && /DTEND:20261112T060000Z/.test(ics), ics);
check("a start with no offset is read in the event's own zone", /DTSTART:20261112T030000Z/.test(EC.buildEventIcs({ ...EVENT, startAt: "2026-11-11T19:00:00", endAt: null }, NOW)!) && /DTEND:20261112T050000Z/.test(EC.buildEventIcs({ ...EVENT, startAt: "2026-11-11T19:00:00", endAt: null }, NOW)!));
check("name, place and link are in it", /SUMMARY:Founders Dinner/.test(ics) && /LOCATION:The Battery\\, 717 Battery St\\, San Francisco/.test(ics) && /URL:https:\/\/lu\.ma\/fd/.test(ics));
check("an unreadable start gives no file", EC.buildEventIcs({ ...EVENT, startAt: "soon" }, NOW) === null);
const r = await EC.sendGoingCalendar("u1", "evt-1", deps("jordan@studio.co", EVENT));
check("going: the file is emailed to the member's own address, once", r.sent && sent.length === 1 && sent[0].to === "jordan@studio.co" && /DTSTART:20261112T030000Z/.test(sent[0].ics) && sent[0].filename === "event.ics", sent);
const noEmail = await EC.sendGoingCalendar("u1", "evt-1", deps(null, EVENT));
const noEvent = await EC.sendGoingCalendar("u1", "evt-x", deps("a@b.co", null));
check("no email on file or no such event: nothing is sent", !noEmail.sent && !noEvent.sent && sent.length === 1);

// ---- only updateGoing builds one; plans get none
const conv = src("agent/conversationTools.ts");
const going = conv.slice(conv.indexOf("updateGoing: tool({"), conv.indexOf("saveFeedbackForTeam: tool({"));
check("the calendar file is sent from updateGoing only, and only when going", /if \(going && !ctx\.dryRun\)/.test(going) && /sendGoingCalendar\(ctx\.userId, subject\.eventApiId\)/.test(going) && (conv.match(/services\/eventCalendar\.js/g) ?? []).length === 1);
const callers = fs.readdirSync(new URL("../../src/", import.meta.url), { recursive: true }).map(String).filter((f) => f.endsWith(".ts")).filter((f) => /eventCalendar|text\/calendar|BEGIN:VCALENDAR/.test(src(f))).sort();
check("no other code builds or attaches a calendar file", callers.join() === ["agent/conversationTools.ts", "services/eventCalendar.ts"].join(), callers);
const registryText = Cap.ABILITIES.map((a) => `${a.can} ${a.use ?? ""} ${a.sheet ?? ""}`).join("\n");
check("no ability offers a plan, a sheet or calendar holds", !/calendar holds?|\.ics|one-page (plan|sheet)|email_plan|emailPlan/i.test(registryText));
check("a plan-sheet request (a sheet, calendar holds for each time) is recognised as something Cue no longer does: no file, no offer", Cap.NOT_ASSISTANT_ASK.test("put my Saturday plan on a one-page sheet with a calendar hold for each time") && Cap.NOT_ASSISTANT_ASK.test("make me a plan sheet for Saturday"));

// ---- not an assistant: no task for it, by text or on a call
const T = await import("../../src/agent/conversationTools.js");
const quiet = console.log;
console.log = () => {};
const mk = (msg: string, isVoice = false) => T.createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: msg, isVoice, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, isTeam: false, sendCoReply: async () => true, facts: { add: () => {}, text: () => "" } } as any);
const asks = ["Can you draft an email to the venue about Friday?", "write an email to the host asking about the rate", "find me a job in product", "read my inbox and tell me what's waiting"];
const outs: any[] = [];
for (const m of asks) for (const voice of [false, true]) {
  const t = mk(m, voice);
  outs.push(await (t.tools as any).startTask.execute({ goal: m.slice(0, 40), theirWords: m, steps: ["a"], firstStep: "a", inHours: 2 }, {}).catch((e: unknown) => ({ ok: false, err: String(e) })));
}
console.log = quiet;
check("a request to draft their email (or find a job, read their inbox) is not accepted as a task, on text or on a call", outs.every((o) => o.ok === false && /not something you do/.test(o.error ?? "")), outs);
const ok = await (mk("let me know when a founders dinner shows up in the Mission") as any).tools.startTask.execute({ goal: "founders dinners in the Mission", theirWords: "let me know when a founders dinner shows up in the Mission", steps: ["look"], firstStep: "look", inHours: 3, lookout: true }, {}).catch((e: unknown) => ({ ok: false, err: String(e) }));
check("a look-out is still accepted", ok.ok === true, ok);
const { CAPABILITY_SHEET } = await import("../../src/services/callBriefing.js");
check("the call sheet says Cue doesn't draft emails, plan sheets or search jobs, and never claims it did", /Not something you do, so no task for it: drafting their emails, plan sheets, job searches, reading their email/.test(CAPABILITY_SHEET));

// ---- nothing offers a sheet, a brief or a document kind we dropped
const O = await import("../../src/services/documentOffer.js");
check("artifact offers: only a corrected version of a document remains", JSON.stringify(O.ARTIFACT_ORDER) === JSON.stringify(["drift"]));
const base: any = { now: NOW, helpAsks: [], threads: [], recurring: [], needsCare: false, history: [], notes: { picked: "x", when: "Saturday", what: "a dinner for 40", headcount: 40, kind: "venue" }, delivered: [], openWork: [], drift: [], message: "we're hosting a dinner for 40 on Nov 20 at 7pm then 9pm", coLines: ["7pm dinner then 9pm drinks"] };
check("neither a sheet nor a brief is offered, even for a settled plan or a hosting message", !O.artifactOfferDue("plan", base).due && !O.artifactOfferDue("brief", base).due);
check("the research line in the menu sends finds, not a brief", !/send a brief/.test(src("services/capabilities.ts")));
check("the venue_brief document kind is gone", !/venue_brief/.test(src("services/documentSheet.ts") + src("services/documentDelivery.ts") + src("agent/loopTools.ts") + src("services/capabilities.ts") + src("services/speakable.ts")));

// ---- the Gmail cleanup: nothing without --apply
const S = await import("../../src/scripts/revokeGmailGrants.js");
const calls: string[] = [];
const rows = [{ user_id: "u1", refresh_token_enc: null, access_token_enc: null }];
const db: any = { query: async (q: string) => (calls.push(q), /COUNT\(\*\)::int AS n, COUNT/.test(q) ? { rows: [{ n: 1, gmail: 1 }] } : /FROM docs_grants/.test(q) && /COUNT/.test(q) ? { rows: [{ n: 1 }] } : /COUNT\(\*\)::int AS n FROM google_snapshots/.test(q) ? { rows: [{ n: 2 }] } : /SELECT user_id/.test(q) ? { rows } : { rows: [], rowCount: 1 }) };
const counts = await S.countGmailGrants(db);
check("dry run: counts only, and it only reads", JSON.stringify(counts) === JSON.stringify({ connections: 1, withGmailScope: 1, waitingSnapshots: 2, docsGrants: 1 }) && calls.every((q) => /^SELECT/.test(q)), calls);
const applied = await S.applyGmailCleanup(db, async () => {});
check("apply: deletes each google_connections row and nulls waiting, counts only back", applied.deleted === 2 && applied.nulled === 1 && calls.some((q) => /DELETE FROM google_connections/.test(q)) && calls.some((q) => /DELETE FROM docs_grants/.test(q)) && calls.some((q) => /UPDATE google_snapshots SET waiting = NULL/.test(q)));
const sc = src("scripts/revokeGmailGrants.ts");
check("the script does nothing unless exactly one of --dry-run or --apply is passed", /if \(apply === dry\) \{[\s\S]{0,200}Nothing was done/.test(sc) && /process\.argv\.slice\(2\)/.test(sc) && !/console\.log\([^)]*(email|token|user_id)/i.test(sc.replace(/refresh_token_enc|access_token_enc|user_id/g, "")));
check("it never touches the calendar grant (Gmail and Docs grants only)", !/calendar_grants/.test(sc.replace(/^\/\/.*$/gm, "")) && /docs_grants/.test(sc));

console.log(`assistant helpers removal: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
