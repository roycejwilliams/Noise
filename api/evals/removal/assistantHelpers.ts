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
const asks = ["Can you draft an email to the venue about Friday?", "write an email to the host asking about the rate", "read my inbox and tell me what's waiting"];
const outs: any[] = [];
for (const m of asks) for (const voice of [false, true]) {
  const t = mk(m, voice);
  outs.push(await (t.tools as any).startTask.execute({ goal: m.slice(0, 40), theirWords: m, steps: [m.slice(0, 40)], firstStep: m.slice(0, 40), inHours: 2 }, {}).catch((e: unknown) => ({ ok: false, err: String(e) })));
}
console.log = quiet;
check("a request to draft their email (or find a job, read their inbox) is not accepted as a task, on text or on a call", outs.every((o) => o.ok === false && /not something you do/.test(o.error ?? "")), outs);
const ok = await (mk("let me know when a founders dinner shows up in the Mission") as any).tools.startTask.execute({ goal: "founders dinners in the Mission", theirWords: "let me know when a founders dinner shows up in the Mission", steps: ["look"], firstStep: "look", inHours: 3, lookout: true }, {}).catch((e: unknown) => ({ ok: false, err: String(e) }));
const mixed = "write an email to my landlord ugh. anyway any founder dinners this week?";
const dinner = await (mk(mixed) as any).tools.startTask.execute({ goal: "founder dinners this week", theirWords: "any founder dinners this week?", steps: ["look for founder dinners"], firstStep: "look for founder dinners", inHours: 3 }, {}).catch((e: unknown) => ({ ok: false, err: String(e) }));
check("an email aside in the same message doesn't block the dinner task (only the task being started is tested)", dinner.ok === true, dinner);
const jobs = await (mk("keep an eye out for job openings in climate tech") as any).tools.startTask.execute({ goal: "job openings in climate tech", theirWords: "keep an eye out for job openings in climate tech", steps: ["watch for climate tech openings"], firstStep: "watch for climate tech openings", inHours: 3, lookout: true }, {}).catch((e: unknown) => ({ ok: false, err: String(e) }));
check("a job-openings look-out starts (openings and opportunity discovery are kept)", jobs.ok === true, jobs);
check("a look-out is still accepted", ok.ok === true, ok);
const { CAPABILITY_SHEET } = await import("../../src/services/callBriefing.js");
check("the call sheet says Cue doesn't draft emails, plan sheets or search jobs, and never claims it did", /Not something you do, so no task for it: drafting their emails, plan sheets, reading their email/.test(CAPABILITY_SHEET));

// ---- nothing offers a sheet, a brief or a document: the offer and delivery modules are gone
const gone = (f: string) => !fs.existsSync(new URL(`../../src/${f}`, import.meta.url));
check("the document offer, delivery, receipts, Google Docs and plan-file modules are deleted", ["services/documentOffer.ts", "services/documentDelivery.ts", "services/deliveryReceipts.ts", "services/receiptDrift.ts", "services/googleDocs.ts", "services/planFile.ts", "services/planSheet.ts", "services/planEmail.ts"].every(gone));
check("the research line in the menu sends finds, not a brief", !/send a brief/.test(src("services/capabilities.ts")));
check("no venue_brief document kind anywhere in the source", !/venue_brief/.test(callers.length ? Cap.ABILITIES.map((a) => `${a.can} ${a.use ?? ""}`).join("") : ""));

const na = Cap.ABILITIES.find((a) => a.id === "not_assistant")!;
check("the decline line says Cue disconnects only the calendar (no Google Docs)", !/Docs/.test(`${na.sheet} ${na.can}`) && /disconnects the calendar if that's what they mean/.test(na.can));
// ---- goals: no draft piece that ends in a document
const GO = await import("../../src/services/goalOwnership.js");
const cleaned = GO.cleanItems([{ text: "a note to the venue", who: "co", how: "draft" }, { text: "venues for 40", who: "co", how: "research" }, { text: "founder dinners", who: "co", how: "watch" }]);
check("a draft piece is no longer Cue's: it stays the member's; research and watch stay", cleaned[0].owner === "member" && cleaned[0].how === null && cleaned[1].how === "research" && cleaned[2].how === "watch", cleaned);
const plan = GO.itemTaskPlan({ id: 1, title: "launch" } as any, { n: 2, text: "venues for 40", owner: "co", how: "research", reach: "internal", taskId: null, status: "offered" } as any);
check("a goal piece's task never says 'send it as a document'", !/document|Draft/.test(plan.steps.join(" ") + plan.goal), plan);
check("no offer line says Cue can draft", GO.offerFactLines([{ text: "venues", how: "research", suggest: null }, { text: "dinners", how: "watch", suggest: null }]).every((l) => !/draft/i.test(l)));
const goalsSrc = src("services/goalOwnership.ts") + src("agent/conversationTools.ts") + src("services/capabilities.ts");
check("the takeOnGoal schema, sheet and guidance no longer offer drafts", !/"research", "draft"|research, draft|drafts, watching|offer to draft/.test(goalsSrc));
check("a goal piece task already open as a draft closes as dropped when it wakes, no text", /\^Draft:\/i\.test\(t\.goal\)/.test(src("services/taskTurn.ts")) && /drafting a piece as a document was removed/.test(src("services/taskTurn.ts")));

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
