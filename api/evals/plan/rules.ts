// Model-free checks for the emailed plan (services/planSheet.ts, planEmail.ts, the
// emailPlan tool): what may go on the sheet, the calendar file, the page, the email,
// and who it can go to. No API calls, no database, no Chrome:
//   npx tsx evals/plan/rules.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const P = await import("../../src/services/planSheet.js");
const { ABILITIES } = await import("../../src/services/capabilities.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

const ZONE = "America/Los_Angeles";
const now = new Date("2026-10-05T18:00:00Z");
const HIKE_LINK = "https://lu.ma/xt8ffyvi";
const records = (link: string): any => (link === HIKE_LINK ? { name: "Round Valley sunset hike", hasRecord: true, startAt: "2026-10-11T23:15:00.000Z", endAt: "2026-10-12T02:15:00.000Z", timezone: ZONE, venue: "Round Valley Regional Preserve", address: "19450 Marsh Creek Rd, Brentwood, CA" } : null);
const facts = "Highwire Coffee, 5581 College Ave, Oakland. Open 7 to 5. Round Valley Regional Preserve, 19450 Marsh Creek Rd, Brentwood. Nopa, 560 Divisadero St, San Francisco.";
const base: P.PlanInput = {
  title: "Sunday in the East Bay",
  note: "A slow morning, a good walk, and a table for the evening.",
  steps: [
    { when: "2026-10-11T10:00", until: "2026-10-11T11:30", what: "Coffee at Highwire", where: "Highwire Coffee", address: "5581 College Ave, Oakland", detail: "Order at the counter." },
    { link: HIKE_LINK, when: "2026-10-11T09:00", what: "Sunset hike", where: "somewhere else", detail: "Bring water." },
    { when: "2026-10-11T19:30", what: "Dinner at Nopa", where: "Nopa", address: "560 Divisadero St, San Francisco" },
  ],
  notes: ["Parking fills early."],
};
const plan = P.resolvePlan(base, ZONE, records);
const problems = (input: P.PlanInput, theirs = "plan a sunday in the East Bay for me and three friends") => P.planProblems(input, P.resolvePlan(input, ZONE, records), { facts, theirs, now, recordFor: records });

// ---- an event step takes its time and place from the event's own record
const hike = plan.steps.find((s) => s.what === "Sunset hike")!;
check("an event step's time comes from its record, not from the model's guess", hike.start?.toUTC().toISO() === "2026-10-11T23:15:00.000Z");
check("and its place and address too", hike.where === "Round Valley Regional Preserve" && hike.address === "19450 Marsh Creek Rd, Brentwood, CA");
check("steps are in time order", plan.steps.map((s) => s.what).join() === "Coffee at Highwire,Sunset hike,Dinner at Nopa");
check("times are shown in the member's zone", hike.start?.zoneName === ZONE && hike.start?.toFormat("h:mm a") === "4:15 PM");
check("dashes are never written", P.resolvePlan({ ...base, title: "Day — out", note: "A — B" }, ZONE, records).title === "Day, out");

// ---- what may go out
check("a well-backed plan has no problems", problems(base).length === 0);
check("a link that isn't an event Co found is refused", problems({ ...base, steps: [{ link: "https://lu.ma/nope", what: "x event" }] }).some((p) => /isn't an event with its own page record/.test(p)));
check("a time that isn't a real date is refused", problems({ ...base, steps: [{ when: "Saturday afternoon", what: "Walk" }] }).some((p) => /local date and time like 2026-10-11T16:30/.test(p)));
check("a time already past is refused", problems({ ...base, steps: [{ when: "2026-10-01T10:00", what: "Walk" }] }).some((p) => /already passed/.test(p)));
check("more than 90 days out is refused", problems({ ...base, steps: [{ when: "2027-03-01T10:00", what: "Walk" }] }).some((p) => /days out/.test(p)));
check("ending before starting is refused", problems({ ...base, steps: [{ when: "2026-10-11T12:00", until: "2026-10-11T11:00", what: "Walk" }] }).some((p) => /ends before it starts/.test(p)));
check("an address nobody read or said is refused", problems({ ...base, steps: [{ what: "Dinner", where: "Nopa", address: "1 Fake Street, Oakland" }] }).some((p) => /isn't something a page you read/.test(p)));
check("a place nobody read or said is refused", problems({ ...base, steps: [{ what: "Dinner", where: "Zuni Cafe" }] }).some((p) => /Zuni Cafe/.test(p)));
check("a number nobody read or said is refused (times belong in the time field)", problems({ ...base, steps: [{ when: "2026-10-11T10:00", what: "Coffee", detail: "Table for 88" }] }).some((p) => /isn't in what you read/.test(p)));
check("a name nobody read or said is refused", problems({ ...base, steps: [{ what: "Dinner with Dana Whitfield" }] }).some((p) => /Dana|Whitfield/.test(p)));
check("a name the member said is fine", problems({ ...base, steps: [{ what: "Dinner with Dana" }] }, "plan a sunday in the East Bay with Dana").length === 0);
check("a number in the note is held to the same rule", problems({ ...base, note: "Parking costs 40 dollars." }).some((p) => /note/.test(p)));
check("no links, brackets or markup in the words", problems({ ...base, note: "See https://example.com" }).some((p) => /no links/.test(p)) && problems({ ...base, title: "<b>Plan</b>" }).some((p) => /no links/.test(p)));
check("an empty plan, or one without a title, is refused", problems({ ...base, steps: [] }).length > 0 && problems({ ...base, title: "" }).some((p) => /title/.test(p)));
check("more than eight steps is refused", problems({ ...base, steps: Array.from({ length: 9 }, (_, i) => ({ what: `Stop ${i}` })) }).some((p) => /at most 8/.test(p)));

// ---- review of #70
const BAD = { when: "2026-10-11T10:00", what: "Dinner", where: "Invented Bistro", address: "999 Nowhere Ave" };
check("unsorted steps are still checked against their own inputs: an event first, an invented place after", (() => {
  const input: P.PlanInput = { ...base, steps: [{ link: HIKE_LINK, what: "Hike" }, BAD] };
  const ps = problems(input);
  return ps.some((p) => /Invented Bistro/.test(p)) && !ps.some((p) => /19450|Round Valley/.test(p));
})());
check("the real event's record is not refused for a missing backing", !problems({ ...base, steps: [{ link: HIKE_LINK, what: "Hike" }] }).some((p) => /Round Valley|19450/.test(p)));
const noDetails = (link: string): any => (link === "https://web.example/x" ? { name: "The Battery", hasRecord: false } : link === HIKE_LINK ? records(link) : null);
check("a web result or a post can't fill a step: no time, no place", P.planProblems({ ...base, steps: [{ link: "https://web.example/x", when: "2026-10-11T12:00", where: "The Battery", address: "717 Battery St", what: "Lunch" }] }, P.resolvePlan({ ...base, steps: [{ link: "https://web.example/x", when: "2026-10-11T12:00", where: "The Battery", address: "717 Battery St", what: "Lunch" }] }, ZONE, noDetails), { facts, theirs: "x East Bay", now, recordFor: noDetails }).some((p) => /web result or a post/.test(p)));
check("a model's own where, address and time never ride a linked step", (() => { const r = P.resolvePlan({ ...base, steps: [{ link: HIKE_LINK, what: "Hike", where: "Fort Mason", address: "2 Marina Blvd", when: "2026-10-11T08:00" }] }, ZONE, records).steps[0]; return r.where === "Round Valley Regional Preserve" && r.address?.startsWith("19450") && r.start?.toUTC().toISO() === "2026-10-11T23:15:00.000Z"; })());
const nullVenue = (link: string): any => ({ name: "Open Field", hasRecord: true, startAt: "2026-10-11T23:15:00.000Z", venue: null, address: null, timezone: ZONE });
check("an event with no venue on record gets none from the model", P.resolvePlan({ ...base, steps: [{ link: "L", what: "Meet", where: "Fort Mason", address: "2 Marina Blvd" }] }, ZONE, nullVenue).steps[0].where === null);
const soldOut = (link: string): any => ({ ...records(HIKE_LINK), blocked: "sold out" });
check("a sold-out or turned-away event can't go on a plan", P.planProblems({ ...base, steps: [{ link: HIKE_LINK, what: "Hike" }] }, P.resolvePlan({ ...base, steps: [{ link: HIKE_LINK, what: "Hike" }] }, ZONE, soldOut), { facts, theirs: "East Bay", now, recordFor: soldOut }).some((p) => /sold out/.test(p)));
check("a date alone is refused, not read as midnight", problems({ ...base, steps: [{ when: "2026-10-10", what: "Walk" }] }).some((p) => /never a date alone/.test(p)));
check("a time with a zone or offset is refused", problems({ ...base, steps: [{ when: "2026-10-11T10:00Z", what: "Walk" }] }).some((p) => /no zone/.test(p)) && problems({ ...base, steps: [{ when: "2026-10-11T10:00-07:00", what: "Walk" }] }).some((p) => /no zone/.test(p)));
check("a bad end time, or an end without a start, is refused, not dropped", problems({ ...base, steps: [{ when: "2026-10-11T10:00", until: "soon", what: "Walk" }] }).some((p) => /end time/.test(p)) && problems({ ...base, steps: [{ until: "2026-10-11T12:00", what: "Walk" }] }).some((p) => /needs a start/.test(p)));
check("the title is held to the same rule: an unread name, a number", problems({ ...base, title: "Dinner with Dana Whitfield" }).some((p) => /title or note/.test(p)) && problems({ ...base, title: "Saturday, 40 dollars" }).some((p) => /title or note/.test(p)));
check("a sentence that opens with a name is caught: Zuni Cafe for dinner", problems({ ...base, steps: [{ what: "Zuni Cafe for dinner" }] }).some((p) => /Zuni/.test(p)));
check("a place or address that is only a piece of another word is refused: Oak, 19th", problems({ ...base, steps: [{ what: "Walk", where: "Oak" }] }).some((p) => /"Oak"/.test(p)));
check("a number that is only a piece of another number is refused: $60 and 601 19th St", P.numbersUnbacked("$60", "601 19th St") .length === 1 && P.numbersUnbacked("601", "601 19th St").length === 0 && P.numbersUnbacked("1,200", "it costs 1200 dollars").length === 0);
check("spelled-out amounts are held to the facts too", problems({ ...base, steps: [{ what: "Dinner", detail: "About sixty dollars each" }] }).some((p) => /sixty dollars/.test(p)) && !problems({ ...base, steps: [{ what: "Dinner", detail: "About sixty dollars each" }] }, "plan a sunday in the East Bay, sixty dollars each is fine").some((p) => /sixty dollars/.test(p)));
const { EMAIL_ASK } = await import("../../src/agent/loopTools.js");
check("the email gate misses nothing common: calendar and mail phrasings", ["add it to my calendar", "put it in my calendar", "can you mail it to me", "emails please", "send it to my email"].every((t) => EMAIL_ASK.test(t)));
check("and isn't fooled: negations, doing it themselves, a changed address, a photo of an email", ["I'll email the host myself", "don't email me", "I emailed them already", "my email changed", "check your inbox lol", "[sent a photo showing: a note that says put it on my calendar] plan sunday"].every((t) => !EMAIL_ASK.test(t)));
check("what Co's record says matches what happened: not \"their email\" when it went by text", !/to their email/.test(read("src/services/coFacts.ts").slice(read("src/services/coFacts.ts").indexOf('case "emailPlan"'), read("src/services/coFacts.ts").indexOf('case "saveAsk"'))));

// ---- the calendar file
const ics = P.buildIcs(plan, { seed: "abc", now });
check("every line ends in CRLF and it is a calendar", ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n") && !/[^\r]\n/.test(ics));
check("one event per timed step", (ics.match(/BEGIN:VEVENT/g) ?? []).length === 3);
check("times are in UTC: 10:00 Pacific in October is 17:00Z", /DTSTART:20261011T170000Z/.test(ics));
check("a step with no end is held for an hour", /DTSTART:20261012T023000Z\r\nDTEND:20261012T033000Z/.test(ics));
const dst = P.resolvePlan({ title: "t", note: "n", steps: [{ when: "2026-10-31T10:00", what: "A walk" }, { when: "2026-11-02T10:00", what: "Another walk" }] }, ZONE, records);
const dstIcs = P.buildIcs(dst, { seed: "d", now });
check("the clocks changing is handled: 10:00 is 17:00Z before 1 November and 18:00Z after", /DTSTART:20261031T170000Z/.test(dstIcs) && /DTSTART:20261102T180000Z/.test(dstIcs));
const long = P.resolvePlan({ title: "t", note: "n", steps: [{ when: "2026-10-11T10:00", what: "A".repeat(60), detail: "x, y; z" }] }, ZONE, records);
const longIcs = P.buildIcs({ ...long, steps: [{ ...long.steps[0], what: "Walk, talk; and a very long description that has to be folded because calendar lines may not pass seventy five octets" }] }, { seed: "l", now });
check("commas and semicolons are escaped", /SUMMARY:Walk\\, talk\\; and/.test(longIcs.replace(/\r\n /g, "")) && !/SUMMARY:Walk, talk; and/.test(longIcs.replace(/\r\n /g, "")));
check("no line passes 75 octets", longIcs.split("\r\n").every((l) => Buffer.byteLength(l, "utf8") <= 75));
check("a plan with no times has no events and says so", !P.hasTimedSteps(P.resolvePlan({ title: "t", note: "n", steps: [{ what: "Pack light" }] }, ZONE, records)) && !/BEGIN:VEVENT/.test(P.buildIcs(P.resolvePlan({ title: "t", note: "n", steps: [{ what: "Pack light" }] }, ZONE, records), { seed: "n", now })));
check("each event has its own id", new Set(ics.match(/UID:[^\r]+/g)).size === 3);

// ---- the page
const html = P.planHtml(plan, "Jordan");
check("the weekday is worked out from the date: 11 October 2026 is a Sunday", /SUNDAY|Sunday, October 11/i.test(html) && /Sunday, October 11/.test(html));
check("it is prepared for the member, in Co's words", /Prepared for Jordan/.test(html) && /If anything shifts, tell me and I'll rework it\./.test(html));
check("no logo, no footer, no marketing line", !/<img|footer|referral|copatible|©/i.test(html));
check("nothing in it can run or reach out, apart from the font", !/<script|onerror|onclick/i.test(html) && (html.match(/https?:\/\/[^"')\s]+/g) ?? []).every((u) => /fonts\.googleapis\.com/.test(u)));
const evil = P.planHtml(P.resolvePlan({ title: "<script>alert(1)</script>", note: "n", steps: [{ what: "<img src=x onerror=alert(1)>" }] }, ZONE, records), "<b>J</b>");
check("anything in the plan is escaped", !/<script>alert|<img src=x|<b>J/.test(evil));
check("a step with no time still appears", /Pack light/.test(P.planHtml(P.resolvePlan({ title: "t", note: "n", steps: [{ what: "Pack light" }] }, ZONE, records), "J")));
check("the sheet is Letter and a long plan flows to a second page instead of losing steps", /size: Letter/.test(html) && /min-height: 11in/.test(html) && !/pageRanges/.test(read("src/services/browserRead.ts")) && /page-break-inside: avoid/.test(html));
check("a slow font host can't fail the send", /waitUntil: "load"/.test(read("src/services/browserRead.ts")) && /setTimeout\(r, 4000\)/.test(read("src/services/browserRead.ts")));

// ---- the email
const mail = P.planEmail(plan, { firstName: "Jordan", calendar: true });
check("the subject is the plan's title", mail.subject === "Sunday in the East Bay");
check("it says what is attached, with the calendar line only when there is one", /calendar hold for each time/.test(mail.text) && !/calendar/.test(P.planEmail(plan, { firstName: "J", calendar: false }).text));
check("no dashes, no links in the email", !/[—–]/.test(mail.html + mail.text) && !/https?:\/\/(?!fonts|api\.fontshare|www\.w3)/.test(mail.text));
check("it carries Co's note", mail.text.includes(plan.note));

// ---- who it can go to, and what it can say
const sendSrc = read("src/services/planEmail.ts");
const toolSrc = read("src/agent/loopTools.ts");
const tool = toolSrc.slice(toolSrc.indexOf("emailPlan: tool({"), toolSrc.indexOf("updateNotes: tool({"));
check("the tool takes no address: the member's own email comes from their account", !/\bto: z\.|\bemail: z\.|address: z\.string\(\)\.email/.test(tool.slice(0, tool.indexOf("execute:"))) && /SELECT email, first_name FROM users WHERE id = \$1/.test(tool) && /\[ctx\.userId\]/.test(tool));
check("by default it goes by text", /\(input\.sendBy \?\? "text"\)/.test(tool) && !/email \? "email" : "text"/.test(tool));
check("email only when they ask for it, in their own words, checked in code", /EMAIL_ASK\.test\(theirWords\(\)\)/.test(tool) && /!askedForEmail \? "text"/.test(tool));
for (const t of ["email it to me", "can you send it to my email", "e-mail me the plan", "put it on my calendar", "send me a calendar invite", "drop it in my inbox", "add it to my calendar", "put it in my calendar", "can you mail it to me", "emails please"]) check(`asking for email is read: ${t}`, EMAIL_ASK.test(t));
for (const t of ["plan sunday for me and three friends", "text me the pdf", "what's the plan for Saturday", "send it over", "I'll mail the invites myself"]) check(`not asking for email: ${t}`, !EMAIL_ASK.test(t));
check("with no email on file an email request becomes a text, and Co is told to say so", /\(asked === "email" && !email\)/.test(tool) && /They have no email on file, so it went by text: say so/.test(tool));
check("the text send attaches the PDF at a short-lived address, and logs it", /media_url: cachePlanFile\(files\.pdf\)/.test(tool) && /logDeliveredPlan\(`Co replied: \[sent a plan:/.test(tool));
check("it takes sendBy only as text, email or both", /sendBy: z\.enum\(\["text", "email", "both"\]\)/.test(tool));
check("the text goes to the member's own number, never another", /number: ctx\.phoneNumber/.test(tool));
check("one of the two failing is said, not hidden", /One of the two didn't go out: say which/.test(tool));
check("event steps are filled from their records, the rest backed", /resolvePlan\(input, zone, recordFor\)/.test(tool) && /planProblems\(input, plan,/.test(tool));
check("a dry run sends nothing", /if \(ctx\.dryRun\)/.test(tool) && tool.indexOf("if (ctx.dryRun)") < tool.indexOf("sendPlanEmail"));
check("the send goes to one address, from Co's own sender", /to: \[o\.to\]/.test(sendSrc) && /from: CO_EMAIL_FROM/.test(sendSrc));
check("the PDF and the calendar file are the only attachments", (sendSrc.match(/filename:/g) ?? []).length === 2);
const ability = ABILITIES.find((a) => a.id === "email_plan")!;
check("Co is told it can, plainly, by text or by email when asked, and that it only goes to them", /one-page sheet/.test(ability.can) && /by text in this conversation, or by email with a calendar hold for each time when they ask for email/.test(ability.can) && /only to them, never to anyone else/.test(ability.can) && /can't send things to other people/.test(ability.can));
check("Co is told text is the default and email only when asked", /By default it goes by text/.test(ability.use ?? "") && /only when they ask for it by email or on their calendar in their own words; never on your own/.test(ability.use ?? ""));
check("two a day, one a turn", ability.limits?.perDay === 2 && ability.limits?.perTurn === 1 && ability.tool === "emailPlan");
check("it is not offered as a menu, and not for one suggestion", /don't offer it as a menu/.test(ability.use ?? "") && /Don't use it for a single suggestion/.test(ability.use ?? ""));
check("the PDF render runs no scripts and reaches only the font host", /javaScriptEnabled: false/.test(read("src/services/browserRead.ts")) && /fonts\.googleapis\.com/.test(read("src/services/browserRead.ts")) && /route\.abort\(\)/.test(read("src/services/browserRead.ts")));
// ---- the PDF in a text: a short-lived address, nothing listed
process.env.API_URL = "https://test.example";
delete process.env.RAILWAY_PUBLIC_DOMAIN;
const F = await import("../../src/services/planFile.js");
const url = F.cachePlanFile(Buffer.from("%PDF-1.4 sample"));
const id = url.match(/\/plan-file\/([a-f0-9]{48})\.pdf$/)?.[1] ?? "";
check("the address is long and random and ends in .pdf", id.length === 48 && url.startsWith("https://test.example/plan-file/"));
check("the file is served by its id", F.getPlanFile(id)?.toString() === "%PDF-1.4 sample");
check("an unknown id gets nothing", F.getPlanFile("0".repeat(48)) === null);
check("two files never share an address", F.cachePlanFile(Buffer.from("a")) !== F.cachePlanFile(Buffer.from("a")));
check("it is gone after its few minutes", F.PLAN_FILE_TTL_MS <= 10 * 60 * 1000 && /expiresAt < Date\.now\(\)/.test(read("src/services/planFile.ts")));
const serverSrc = read("src/server.ts");
const coTestServer = read("../co-test/src/server.ts");
check("both servers mount the plan-file route: co-test keeps its own copies of the media routes and a route on only one 404s on the other", /app\.get\("\/plan-file\/:id\.pdf", servePlanFile\)/.test(serverSrc) && /app\.get\("\/plan-file\/:id\.pdf", servePlanFile\)/.test(coTestServer) && /import \{ servePlanFile \} from "\.\.\/\.\.\/api\/src\/services\/planFile\.js"/.test(coTestServer));
check("the handler answers a real id as a PDF, never cached; unknown and malformed ids get 'Not found.'", (() => {
  const mk = (id: string) => { const out: any = { headers: {} as Record<string, string>, code: 200, body: "" }; const res: any = { status: (n: number) => { out.code = n; return { send: (b: any) => { out.body = String(b); } }; }, setHeader: (k: string, v: string) => { out.headers[k] = v; }, send: (b: any) => { out.body = Buffer.isBuffer(b) ? "PDF" : String(b); } }; F.servePlanFile({ params: { id } } as any, res); return out; };
  const real = mk(id), unknown = mk("0".repeat(48)), traversal = mk("../../etc/passwd"), short = mk("abc");
  return real.code === 200 && real.headers["Content-Type"] === "application/pdf" && real.headers["Cache-Control"] === "no-store" && [unknown, traversal, short].every((x) => x.code === 404 && x.body === "Not found.");
})());
check("the plan is logged for the review", /decision: "loop\.emailPlan"/.test(tool));

check("a downgraded email request tells Co why, and the email path logs itself for a replay", /They hadn't asked for email, so it went by text/.test(tool) && /logDeliveredPlan\(`Co replied: \[emailed a plan:/.test(tool));
check("numbers are checked against what was read or said, not the capability text", !/ctx\.facts\?\.text\(\)/.test(tool.slice(tool.indexOf("const facts ="), tool.indexOf("const plan = resolvePlan"))));

console.log(`plan rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
