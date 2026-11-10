// Registering a member for another host's Luma event, end to end through Cue's tools (agent/registrationTools.ts) and the guard every
// tool runs under (agent/toolGuard.ts): the ask, the two approvals, the yes, the recheck, the one submit, the outcome copy, sign-in by
// emailed code, the stops. The browser driver runs a real headless Chromium against local fixtures (evals/registration/fixtures.ts);
// every other request is refused. The store is in memory (fakeStore.ts); the yes read is a fake (no model). Zero tokens, nothing sent.
//   npx tsx evals/registration/conversation.ts
import { chromium, type Browser } from "playwright-core";
import fs from "node:fs";
const { setYesJudgeForTests } = await import("../../src/services/theirYes.js");
const { setSwitchesForTest } = await import("../../src/services/abilitySwitches.js");
const { guardTools, registrationReceipt } = await import("../../src/agent/toolGuard.js");
const T = await import("../../src/agent/registrationTools.js");
const D = await import("../../src/services/eventRegistration/lumaDriver.js");
const Cap = await import("../../src/services/capabilities.js");
const A = await import("../../src/services/eventRegistration/approvals.js");
const L = await import("../../src/services/eventRegistration/lumaFromFind.js");
const C = await import("../../src/services/eventRegistration/copy.js");
const CC = await import("../../src/services/eventRegistration/codeChallenge.js");
const W = await import("../../src/services/whatCoKnows.js");
const RG = await import("../../src/services/eventRegistration/registration.js");

import { NAME_EMAIL, fixtureServer, type Fixture } from "./fixtures.js";
import { fakeRegistrations } from "./fakeStore.js";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 900)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ---- a code caught before the ordinary reply, only with an active challenge, only when it's a code
check("code: a bare code is a code", CC.codeOnlyMessage("482913") === "482913" && CC.codeOnlyMessage("it's 482 913") === "482913" && CC.codeOnlyMessage("code: 482913 thanks") === "482913");
check("not a code: a time, money, a zip, an address, a phone number, a sentence", ["meet at 7", "$20", "20 bucks", "my zip is 94110", "1234 Main St", "call me at 415-555-0101", "see you at 7:30", "I have 3 questions", "2026"].every((t) => CC.codeOnlyMessage(t) === null));
{
  let reads = 0;
  const deps = (held: string[]) => ({ heldAny: () => held.length > 0, isHeld: (id: string) => held.includes(id), query: async () => { reads++; return { rows: [{ id: "reg-1", user_id: "u-1" }] }; } });
  check("no active challenge anywhere: a numeric text flows, with no database read", (await CC.catchCode("+14155550101", "482913", deps([]))) === null && reads === 0);
  check("a challenge for a session that isn't held (expired): flows", (await CC.catchCode("+14155550101", "482913", deps(["reg-other"]))) === null);
  const caught = await CC.catchCode("+14155550101", "482913", deps(["reg-1"]));
  check("an active challenge and a bare code: caught, with the placeholder in its place", caught?.code === "482913" && caught.registrationId === "reg-1" && caught.placeholder === CC.CODE_PLACEHOLDER && !caught.placeholder.includes("482913"));
  check("an active challenge and an unrelated numeric message: flows", (await CC.catchCode("+14155550101", "meet at 7", deps(["reg-1"]))) === null && (await CC.catchCode("+14155550101", "$20", deps(["reg-1"]))) === null);
  const route = src("routes/sendblue.ts");
  const at = (re: RegExp) => route.search(re);
  check("route: the code is caught before the delivery is saved, held, stamped, threaded or traced", at(/const regCode =/) > 0 && at(/if \(regCode\) req\.body\.content = regCode\.placeholder;/) < at(/INSERT INTO inbound_webhook_handles \(handle\) VALUES/) && at(/req\.body\.content = regCode\.placeholder/) < at(/SET payload = \$2::jsonb/) && at(/req\.body\.content = regCode\.placeholder/) < at(/claimTextLogin\(lockKey/) && at(/req\.body\.content = regCode\.placeholder/) < at(/traceName: "sendblue\.readTurn"/));
  check("route: a caught code skips the ordinary reply; their line is kept as the placeholder", /User said: \$\{regCode\.placeholder\}/.test(route) && /continueWithCode\(/.test(route) && /if \(regCode && lockKey\) \{[\s\S]{0,1200}return;\n      \}/.test(route));
  check("route: only while registration is live (no challenge can exist before)", /registrationLive\(\)\s*\n?\s*\? await catchCode/.test(route));
  check("the code is never a tool input or a registry tool", !Cap.REGISTRATION_ABILITIES.some((a) => /Code/.test(a.tool ?? "")) && !/useRegistrationCode/.test(src("agent/registrationTools.ts")));
}

// ---- saved answers: visible in what Cue knows, factual details apart from one event's answers, removable, status kept
{
  const raw: any = { profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [],
    signups: W.signupsOf([{ id: "00000000-0000-4000-8000-0000000000a1", event_name: "Founders Dinner", form: { fields: [{ id: "c", label: "What company do you work for?", kind: "company" }, { id: "w", label: "Why do you want to attend?", kind: "open_question" }] }, answers: { c: { value: "Northwind", source: "member" }, w: { value: "To meet climate investors.", source: "draft_approved" } } }], RG.FACTUAL_KINDS) };
  const items = W.knownItems(raw);
  const detail = items.find((i) => i.group === "signupDetails");
  const answer = items.find((i) => i.group === "signupAnswers");
  check("visible: a factual detail and an event answer, in separate groups", detail?.text === "What company do you work for?: Northwind (given for Founders Dinner)" && answer?.text === `for Founders Dinner, "Why do you want to attend?": To meet climate investors. (Cue's draft you approved)`, items);
  check("visible: both groups have their own titles", W.GROUP_TITLES.signupDetails === "Details you gave for event signups" && W.GROUP_TITLES.signupAnswers === "Your answers on event signups");
  const said: { sql: string; a: any[] }[] = [];
  // The registration still repeats the answer in the scope its yes was read against, the ask that showed it, and Cue's draft of it.
  const kept = { scope: { shares: [{ label: "What company do you work for?", value: "Northwind" }, { label: "Why do you want to attend?", value: "To meet climate investors." }], agrees: [] }, ask_text: `Founders Dinner is on Fri. I'd use your company (Northwind), with this answer: "Why do you want to attend?": "To meet climate investors.". Want me to register you for this event using these details and answers?`, drafts: [{ fieldId: "w", text: "To meet climate investors.", basis: "x" }] };
  const db: any = { query: async (sql: string, a: any[]) => { said.push({ sql, a }); return /^SELECT scope, ask_text, drafts/.test(sql) ? { rows: [kept], rowCount: 1 } : { rows: [], rowCount: 1 }; } };
  const out: any = await W.applyOne(db, "u", raw, answer!, "remove", null, "forget my answer for the founders dinner");
  const upd = said.find((x) => /UPDATE event_registrations SET answers = answers - \$3::text/.test(x.sql));
  check("forget: removes that one answer from the registration's record", out?.now === null && !!upd && upd.a[2] === "w", { out, said });
  check("forget: the removed value is scrubbed from the scope, the ask's text and the draft (removed is deleted), the other answer kept", !!upd && !String(upd.a[3]).includes("To meet climate investors.") && String(upd.a[3]).includes("Northwind") && !String(upd.a[4]).includes("To meet climate investors.") && String(upd.a[4]).includes("[removed]") && JSON.parse(String(upd.a[5])).length === 0, upd?.a);
  check("forget: the scope's fingerprint (its hash) is kept", !!upd && !/scope_hash/.test(upd.sql));
  check("forget: the registration's status is left as it is", !/status/.test(said[0].sql));
  check("a signup answer can only be removed, not rewritten", !!(await W.applyOne(db, "u", raw, detail!, "correct", "Acme", "change it to Acme") as any).why);
}

// ---- who the event is for, put in the submit ask as the page's own words (live test 2026-11-09)
{
  const RGx = await import("../../src/services/eventRegistration/registration.js");
  const capturedText = fs.readFileSync(new URL("./fixtures/luma-registered-capture.txt", import.meta.url), "utf8");
  const form: any = { url: "https://luma.com/example-event", eventName: "Sam Example @ Stanford AI Club", when: "Wed Nov 11, 5:30 PM", action: "register", tickets: [], priceText: "Free", gate: "none", readAt: "x", restrictions: RGx.restrictionsIn(capturedText.split("About Event")[1] ?? ""), fields: [{ id: "name", label: "Name", kind: "name", required: true }, { id: "email", label: "Email", kind: "email", required: true }] };
  const facts: any = { first_name: { value: "Jordan", source: "account" }, last_name: { value: "Ellis", source: "account" }, email: { value: "member@example.com", source: "account" } };
  const plan = RGx.planFill(form, facts);
  const ask = C.submitAsk({ eventName: form.eventName, when: form.when, email: "member@example.com", link: form.url }, plan, RGx.scopeOf(form, plan), null);
  check("the captured page's restriction is put to them word for word, before the question, never judged", ask.includes(`Their page also says: "This event is open to Stanford students and affiliates." Only say yes if that fits you.`) && /Want me to register you for this event using these details\?$/.test(ask), ask);
  const plain = RGx.planFill({ ...form, restrictions: [] }, facts);
  check("no restriction on the page: no such line", !C.submitAsk({ eventName: "x", when: null, email: "a@b.c", link: "l" }, plain, RGx.scopeOf({ ...form, restrictions: [] }, plain), null).includes("Their page also says"));
}

// ---- the fit line's guidance, pinned (Royce, 2026-11-09, after the paid fit run): their specific reason, backed by both, or nothing
{
  const use = Cap.toolUse("prepareEventRegistration");
  const pin = [
    "naming their SPECIFIC reason, from their own words or what they've told you, that the event's own page backs",
    "Never a vague one (\"lines up with where you are right now\") and never just a description of the event.",
    "If no specific reason is backed by both their own words and the event's page, leave it out.",
  ];
  check("fit guidance in the tool's description: specific reason, backed by both, never vague, never just the event", pin.every((x) => use.includes(x)) && !use.includes("on why it fits, only from the event's own page or what the find said"), use);
  check("fit guidance on the tool's fit input says the same", T.FIT_DESCRIBE.includes("SPECIFIC reason") && T.FIT_DESCRIBE.includes("never just a description of the event") && T.FIT_DESCRIBE.includes("leave it out"));
  check("the fit quality script uses the same guidance", /FIT_DESCRIBE/.test(fs.readFileSync(new URL("./fitQuality.ts", import.meta.url), "utf8")));
}
// ---- the stored outcome never keeps the member's own name or email
{
  const facts: any = { first_name: { value: "Jordan", source: "account" }, last_name: { value: "Ellis", source: "account" }, email: { value: "member@example.com", source: "account" } };
  const red = T.redactMember("You’re In Jordan Ellis · member@example.com Add to Calendar other@example.org", ["member@example.com"], facts);
  check("outcome detail: name and email redacted (and any other email)", red === "You’re In [member] · [member] Add to Calendar [email]", red);
  check("outcome detail: nothing to redact stays as it is", T.redactMember("You’re In", [], facts) === "You’re In" && T.redactMember(null, [], facts) === null);
  check("outcome detail: their name in another case is still theirs", T.redactMember("Welcome, JORDAN ELLIS (Member@Example.com)", ["member@example.com"], facts) === "Welcome, [member] ([member])", T.redactMember("Welcome, JORDAN ELLIS (Member@Example.com)", ["member@example.com"], facts));
  // Review 2026-11-09: the "didn't go through" line quoted the page's raw words to the member. Now their name and email are out, capped.
  const raw = "Sorry Jordan Ellis, we couldn't register member@example.com: this event is at capacity and the waitlist is closed. Contact host@example.org with questions about future dates and other events in the series this winter.";
  const qt = T.failedQuote(raw, ["member@example.com"], facts);
  check("failed quote: their name and email are out of it", !!qt && !/Jordan|Ellis|member@example\.com/i.test(qt) && qt.includes("[your name]") && qt.includes("[your email]"), qt);
  check("failed quote: capped at FAILED_QUOTE_CHARS, ending in an ellipsis", !!qt && qt.length <= T.FAILED_QUOTE_CHARS && qt.endsWith("…"), qt);
  const ctxF = { eventName: "Demo Night", when: null, email: "member@example.com", link: "https://luma.com/demo-night" };
  const line = C.outcomeLine(ctxF, "failed", { detail: qt, link: ctxF.link });
  check("failed line: the quote in the member's line carries no name or page email of theirs", line.startsWith("The signup for Demo Night didn't go through: the page said \"Sorry [your name], we couldn't register [your email]") && !/Jordan|Ellis/.test(line), line);
  check("failed quote: nothing on the page, no quote", T.failedQuote(null, [], facts) === null && T.failedQuote("   ", [], facts) === null);
  const st = src("agent/registrationTools.ts");
  const settleFn = st.slice(st.indexOf("async function settle("), st.indexOf("async function settleFound("));
  check("settle: the line quotes failedQuote (never the raw page text)", /detail: res\.state === "failed" \? failedQuote\(res\.detail, theirs, facts\) : null/.test(settleFn) && !/detail: res\.detail, link/.test(settleFn), settleFn.slice(0, 200));
  check("settle: no separate 'blocked' branch (resultFrom never returns it); a blocked read is uncertain, with no page words kept", !/if \(res\.state === "blocked"\)/.test(settleFn) && /res\.state === "unknown" \|\| res\.state === "uncertain" \|\| res\.state === "blocked"\) \{\n\s*await S\.recordOutcome\(userId, rec\.id, \{ state: "uncertain", link: rec\.eventUrl, linkKind: "event_page", detail: null, at \}/.test(settleFn));
  check("driver: resultFrom never returns 'blocked'", !/state: "blocked"/.test(src("services/eventRegistration/lumaDriver.ts")));
  check("removing an answer also scrubs it from the stored outcome detail", JSON.stringify(W.scrubSignupValue({ scope: null, askText: null, drafts: [], outcome: { state: "registered", detail: "You’re In Northwind" } }, "c", "Northwind").outcome) === JSON.stringify({ state: "registered", detail: "You’re In [removed]" }));
  check("the forget-residue audit checks the outcome too", /cols: \["answers", "drafts", "ask_text", "scope", "outcome"\]/.test(src("scripts/forgetResidueAudit.ts")));
}

// ---- today: nothing exists for members, nothing in any prompt changes
check("approvals: copy approved, live submission still off, so registration stays off for members (code constants)", A.LUMA_LIVE_SUBMIT_APPROVED === false && A.REGISTRATION_COPY_APPROVED === true && !A.registrationLive());
check("today: no registration ability in the registry Cue reads (no sheet line, no tool, no prompt change)", !Cap.ABILITIES.some((a) => Cap.REGISTRATION_ABILITIES.some((r) => r.id === a.id)) && !Cap.capabilitySheet().some((l) => /register them for a free Luma/i.test(l)));
check("today: the sheet still says Cue can't register them", Cap.LIMITS.some((l) => /can't book, buy, register them for events/.test(l)));
{
  const { offerNeedingPath } = await import("../../src/services/offerGuard.js");
  const { REGISTRATION_ABILITIES } = Cap;
  check("calls: \"I'll register you\" still needs a call tool that carries it; none of the registration tools run on a call, so it's held", offerNeedingPath("I'll register you for it tonight.") === "book" && REGISTRATION_ABILITIES.every((a) => !a.onCall));
}
check("the reply tools add registration only when live", /if \(registrationLive\(\)\) Object\.assign\(tools, registrationTools\(/.test(src("agent/conversationTools.ts")));
check("registration tools take their descriptions from the registry", Cap.REGISTRATION_ABILITIES.every((a) => a.tool && Cap.toolUse(a.tool) === a.use));
check("only registerForEvent needs their yes (answers and drafts never authorize a submit)", Cap.REGISTRATION_ABILITIES.filter((a) => a.confirm).map((a) => a.tool).join() === "registerForEvent");
check("log: a registration call keeps ids and kinds, never their email, an answer's words or a code", JSON.stringify(registrationReceipt("saveRegistrationAnswers", { registrationId: "r1", answers: [{ fieldId: "email", value: "jordan@work.example", from: "their_words" }], theirApproval: "yes" })) === JSON.stringify({ registrationId: "r1", answered: [{ fieldId: "email", from: "their_words" }] }) && registrationReceipt("sendReply", {}) === null);
check("guard: a registration call's decision row drops their message", /registrationLog\s*\n?\s*\?\s*\{ ability: ability\.id, input: registrationLog/.test(src("agent/toolGuard.ts")));

// ---- tier-3 finds carrying a Luma link (pure + stubbed reads)
{
  const page = { name: "Climate Founders Mixer", startAt: "2026-11-21T02:00:00.000Z", zone: "America/Los_Angeles", hosts: ["Host Collective"] };
  const deps = { expand: async (u: string) => (u === "https://t.co/abc123" ? "https://lu.ma/climate-mixer" : null), readPage: async (u: string) => (u === "https://luma.com/climate-mixer" ? page : null) };
  const x = { name: "Climate Founders Mixer", url: "https://x.com/someone/status/1", postText: "Climate founders mixer Thursday, RSVP https://t.co/abc123", details: { startAt: "2026-11-20T18:00:00-08:00", timezone: "America/Los_Angeles", hosts: [] } };
  const r1 = await L.lumaPageForFind(x, deps);
  check("tier-3: an X find whose own post links the same Luma event becomes registrable (t.co followed read-only)", r1.url === "https://luma.com/climate-mixer", r1);
  const r2 = await L.lumaPageForFind({ ...x, details: { ...x.details, startAt: "2026-11-27T18:00:00-08:00" } }, deps);
  check("tier-3: a mismatched date: no registration offer", r2.url === null && /different days/.test(r2.why), r2);
  const r3 = await L.lumaPageForFind({ ...x, postText: "Climate founders mixer Thursday, details soon" }, deps);
  check("tier-3: no Luma link in the find: link-only, as today (never searched for)", r3.url === null && /no Luma link/.test(r3.why), r3);
  check("tier-3: a Luma link in the page Cue read counts", L.lumaLinksIn({ name: "x", url: "https://example.com/e", read: { excerpt: "Register at https://lu.ma/abc-night." } }).join() === "https://luma.com/abc-night");
}

// ---- fit lines only from verified sources
check("fit: a claim from the event page passes", C.fitProblem("It's a small founders dinner with 40 guests.", "Founders Dinner\n40 guests going") === null);
check("fit: an unbacked attendee claim fails (never guessed)", C.fitProblem("Two attendees run community products.", "Founders Dinner on Fri") !== null);
check("fit: a name the page doesn't have fails (never private member info)", C.fitProblem("Maya from your last dinner is going.", "Founders Dinner, 40 guests going") !== null);

// ---- a held page that breaks while their code goes in: they always get a line, and the record expires by its stage
{
  const SS = await import("../../src/services/eventRegistration/registrationStore.js");
  const DD = await import("../../src/services/eventRegistration/lumaDriver.js");
  const { q: q2, rows: rows2 } = fakeRegistrations();
  const U2 = "00000000-0000-4000-8000-0000000c2222";
  const broken: any = { enterCode: async (c: string) => { throw new Error(`page closed while typing ${c}`); }, close: async () => {} };
  const env2: any = { q: q2, driver: async () => { throw new Error("unused"); }, facts: async () => ({ email: { value: "jordan@example.com", source: "account" } }), theirWords: async () => "", sentFinds: async () => [], resolve: { expand: async () => null, readPage: async () => null }, latestFromThemAt: async () => null, codeSources: [], liveSubmit: true, redactCode: async () => {}, hold: (id: string, ss: any) => DD.holdSession(id, ss), takeHeld: (id: string) => DD.takeHeldSession(id), now: () => new Date() };
  const stage = async (slug: string, detail: string) => {
    const r = await SS.openRegistration(U2, { eventKey: `luma:${slug}`, eventUrl: `https://luma.com/${slug}`, itemKey: null, eventName: "Night Market" }, q2);
    await SS.moveRegistration(U2, r.id, "awaiting_yes", { askKind: "submit", scopeHash: "h" }, q2);
    await SS.moveRegistration(U2, r.id, "needs_member_code", { outcome: { state: "uncertain", link: `https://luma.com/${slug}`, linkKind: "event_page", detail, at: "x" } }, q2);
    DD.holdSession(r.id, broken);
    const out = await T.continueWithCode({ userId: U2, resolvedContent: CC.CODE_PLACEHOLDER }, env2, r.id, "314159");
    return { out, status: rows2.find((x) => x.id === r.id)?.status };
  };
  const a = await stage("night-market", "sign_in");
  check("code entry breaks before a submit: the member gets the existing timeout line and the signup starts over", a.out.text?.startsWith("The signup page timed out while I waited for the code, so nothing was submitted.") === true && a.status === "inspected", a);
  const b = await stage("night-market-2", "after_submit");
  check("code entry breaks after a submit: the existing after-submit timeout line, and it's uncertain", b.out.text?.startsWith("The page timed out before I could enter the code, so the signup for Night Market isn't confirmed.") === true && b.status === "uncertain", b);
  check("a lost browser expires its waiting registrations by stage: after a submit or while reconciling uncertain, else back to the start", /CASE WHEN outcome->>'detail' IN \('after_submit', 'reconcile'\) THEN 'uncertain' ELSE 'inspected' END/.test(SS.EXPIRE_LOST_SQL) && /status IN \('needs_member_code', 'needs_member_step'\)/.test(SS.EXPIRE_LOST_SQL));
  check("the real environment wires lost holds to that expiry", /onHeldLost\(\(ids\) => \{ for \(const id of ids\) void S\.expireLostHold\(id\)/.test(src("agent/registrationTools.ts")));
  check("neither line nor record carries the code", !JSON.stringify([a, b, rows2]).includes("314159"));
}

// ---- the browser flows
let browser: Browser | null = null;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
} catch (err: any) {
  console.log(`SKIP registration flow checks: no local Chromium (${String(err?.message ?? err).split("\n")[0].slice(0, 120)})`);
}

if (browser) {
  const U = "00000000-0000-4000-8000-0000000c1109";
  const terms = "No recording without consent.";
  const FIX: Fixture[] = [
    { slug: "demo-night", name: "Demo Night" },
    { slug: "founders-dinner", name: "Founders Dinner", terms, fields: [...NAME_EMAIL,
      { kind: "text", name: "registration_answers.0.value.company", label: "What company do you work for?", required: true, autocomplete: "organization" },
      { kind: "text", name: "registration_answers.1.value", label: "Why do you want to attend?", required: true },
      { kind: "check", label: "Would you like to subscribe to our newsletter?" },
      { kind: "check", label: "By registering, I agree to the event terms.", required: true },
    ] },
    { slug: "climate-mixer", name: "Climate Founders Mixer", fields: [...NAME_EMAIL,
      { kind: "text", name: "registration_answers.0.value.company", label: "What company do you work for?", required: true, autocomplete: "organization" },
      { kind: "text", name: "registration_answers.1.value", label: "Why do you want to come?", required: true },
    ] },
    { slug: "partner-day", name: "Partner Demo Day", button: "Request to Join", result: "pending" },
    { slug: "pitch-night", name: "Pitch Night", button: "Join Waitlist", result: "waitlist", ticketInfo: { is_free: true, is_sold_out: true } },
    { slug: "paid-workshop", name: "Paid Workshop", ticketInfo: { price: { cents: 2500 }, is_free: false } },
    { slug: "members-mixer", name: "Members Mixer", signIn: { code: "482913", reveals: [{ kind: "text", name: "registration_answers.0.value", label: "Who invited you?", required: true }] } },
    { slug: "plain-signin", name: "Plain Signin", signIn: { code: "771144" } },
    { slug: "guarded", name: "Guarded Event", captcha: true, button: null },
    { slug: "slow-event", name: "Slow Event", result: "timeout", loginCode: "135790" },
    { slug: "lost-event", name: "Lost Event", result: "timeout", lost: true, loginCode: "246810" },
    { slug: "blind-event", name: "Blind Event", result: "timeout" },
    { slug: "brought-night", name: "Brought Night" },
    { slug: "crash-night", name: "Crash Night" },
  ];
  // A stand-in for Luma's server across sessions: it keeps registrations (a lost response too) and shows them when signed in.
  const srv = fixtureServer(FIX);
  const fixtures = srv.fn;
  const submitted: string[] = [];
  const realDriver = D.lumaDriver({ browser: async () => browser!, slot: async () => () => {}, fixtures });
  // Counts every submit any session makes, by event: the duplicate checks read it.
  const driver = { ...realDriver, open: async (url: string) => { const s = await realDriver.open(url); const sub = s.submit; s.submit = async () => { submitted.push(url); return sub(); }; return s; } };
  const finds = FIX.filter((f) => f.slug !== "brought-night").map((f) => ({ key: `event:${f.slug}`, name: f.name!, url: `https://lu.ma/${f.slug}`, details: { startAt: "2026-11-21T02:00:00.000Z", timezone: "America/Los_Angeles", hosts: [] } }));
  const { q, rows, plans } = fakeRegistrations(() => new Date(clock));
  let clock = Date.parse("2026-11-09T18:00:00Z");
  const tick = () => new Date((clock += 60_000));
  let latestFromThem: Date | null = null;
  const redacted: string[] = [];
  let emailCode: string | null = null;
  const env: import("../../src/agent/registrationTools.js").RegistrationEnv = {
    q,
    driver: async () => driver,
    facts: async () => ({ first_name: { value: "Jordan", source: "account" }, last_name: { value: "Ellis", source: "account" }, email: { value: "jordan@example.com", source: "account" } }),
    theirWords: async () => "I'm raising a seed round for my battery startup and want to meet climate investors in SF.",
    sentFinds: async () => finds,
    resolve: { expand: async () => null, readPage: async () => null },
    latestFromThemAt: async () => latestFromThem,
    codeSources: [{ name: "authorized email", code: async () => (emailCode ? { code: emailCode } : { unavailable: "no authorized email access" }) }],
    liveSubmit: true, // fixtures only: the driver itself refuses a live page
    redactCode: async (_u, code) => { redacted.push(code); },
    hold: (id, s) => D.holdSession(id, s),
    takeHeld: (id) => D.takeHeldSession(id),
    now: () => new Date(clock),
  };
  setSwitchesForTest({});
  // The yes read (services/theirYes.ts), faked: a plain yes is a yes; "interesting" and a maybe are not.
  setYesJudgeForTests(async (r) => ({ read: true, yes: /^(yes|yeah|yep|sure|please do|go ahead|do it)\b/i.test(r.message.trim()), why: "fake" }));
  let lastText = "";
  const turn = (message: string, recentCue: string = lastText) => {
    const at = tick();
    latestFromThem = at;
    const notDone: string[] = [];
    const ctx = { userId: U, resolvedContent: message, recentExchange: `Cue: ${recentCue}\nMember: ${message}`, messageArrivedAt: at.getTime(), facts: { add: () => {} } };
    const tools: any = guardTools(T.registrationTools(ctx, env, (w) => notDone.push(w)) as any, { userId: U, resolvedContent: message, dryRun: true, notDone: (w) => notDone.push(w), recentExchange: ctx.recentExchange });
    const run = async (name: string, input: any) => {
      const out = await tools[name].execute(input, {});
      if (out?.sendThisWordForWord) lastText = out.sendThisWordForWord;
      return out;
    };
    return { run, notDone };
  };
  const recOf = (slug: string) => rows.find((r) => r.event_key === `luma:${slug}`);

  // 1. Known fields only: straight to the one submit question.
  {
    const r = await turn("can you sign me up for demo night?").run("prepareEventRegistration", { event: "https://lu.ma/demo-night" });
    check("known fields only: one ask, and it's the submit question", r.ok && r.ask === "submit" && C.SUBMIT_QUESTION.test(r.sendThisWordForWord), r);
    check("known fields only: exact wording", r.sendThisWordForWord === "Demo Night is on Fri Nov 20, 6:00 PM, and it's free. I'd use your name (Jordan Ellis) and your email (jordan@example.com). Want me to register you for this event using these details?", r.sendThisWordForWord);
    const no = await turn("interesting").run("registerForEvent", { registrationId: r.registrationId, theirYes: "interesting" });
    check("\"interesting\" is not a yes: nothing submitted", no.ok === false && !submitted.length, no);
    const yes = await turn("yes").run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("confirmed registration: registered, and said as it is", yes.ok && yes.status === "registered" && yes.sendThisWordForWord === "You're registered for Demo Night, Fri Nov 20, 6:00 PM. Luma's confirmation goes to jordan@example.com.\nhttps://luma.com/demo-night", yes);
    check("submitted exactly once", submitted.filter((u) => /demo-night/.test(u)).length === 1, submitted);
    check("follow-through: the confirmed registration became a plan (registered), never attendance", plans.some((p) => p.event_name_raw === "Demo Night" && p.registration_status === "registered" && p.embedding === null), plans);
    const again = await turn("yes").run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("duplicate: a second yes doesn't register again; says already registered", /already registered|You're registered/.test(again.sendThisWordForWord ?? "") && submitted.filter((u) => /demo-night/.test(u)).length === 1, again);
    const re = await turn("sign me up for demo night").run("prepareEventRegistration", { event: "Demo Night" });
    check("duplicate: asking again finds the record, never a second ask or submit", re.status === "registered" && submitted.filter((u) => /demo-night/.test(u)).length === 1, re);
  }

  // 2-4, 6-7. Missing company + why attend: one combined ask with a draft; an edit saved for this registration; a draft approval never
  // submits; the submit question names the terms; resuming after the answers.
  let firstAnswer = "";
  {
    const draft = { fieldId: "registration_answers.1.value", text: "I'm raising a seed round for a battery startup and want to meet climate investors.", basis: "want to meet climate investors" };
    const r = await turn("I'd love to go to the founders dinner, can you sign me up?").run("prepareEventRegistration", { event: "Founders Dinner", drafts: [draft] });
    check("missing company + why attend: one combined answers ask with the draft", r.ok && r.ask === "answers", r);
    check("answers ask: exact wording", r.sendThisWordForWord === `I can handle the signup for Founders Dinner. They also need your company and a short answer to "Why do you want to attend?". Here's a draft for "Why do you want to attend?": "I'm raising a seed round for a battery startup and want to meet climate investors." Does the draft work, and what should I put for your company?`, r.sendThisWordForWord);
    const bad = await turn("go").run("prepareEventRegistration", { event: "Founders Dinner", drafts: [{ ...draft, text: "I've led 5 climate funds.", basis: "want to meet climate investors" }] });
    check("a draft that invents credentials is refused (never shown)", bad.ok === false && /never said/.test(bad.error), bad);
    // Put the good ask back as the last thing sent.
    const again = await turn("ok").run("prepareEventRegistration", { event: "Founders Dinner", drafts: [draft] });
    const id = again.registrationId;
    const approveOnly = await turn("yes that works").run("registerForEvent", { registrationId: id, theirYes: "yes" });
    check("draft approval alone never submits", approveOnly.ok === false && /approving an answer isn't a yes to register/.test(approveOnly.error) && !submitted.some((u) => /founders-dinner/.test(u)), approveOnly);
    const t = turn("Use this instead: I'm building a battery startup and want to meet climate investors. Company is Northwind.");
    const saved = await t.run("saveRegistrationAnswers", { registrationId: id, answers: [
      { fieldId: "registration_answers.1.value", value: "I'm building a battery startup and want to meet climate investors.", from: "their_words" },
      { fieldId: "registration_answers.0.value.company", value: "Northwind", from: "their_words" },
    ] });
    firstAnswer = "I'm building a battery startup and want to meet climate investors.";
    check("edited draft: saved for this registration, nothing registered", saved.ok && saved.registered === false && recOf("founders-dinner").answers["registration_answers.1.value"]?.value === firstAnswer && !submitted.some((u) => /founders-dinner/.test(u)), saved);
    check("resume after the answers: the submit question comes next, naming the terms and the mailing list", C.SUBMIT_QUESTION.test(saved.sendThisWordForWord), saved);
    check("submit ask with an attestation: exact wording", saved.sendThisWordForWord === `Founders Dinner is on Fri Nov 20, 6:00 PM, and it's free. I'd use your name (Jordan Ellis), your email (jordan@example.com), and your company (Northwind), with this answer: "Why do you want to attend?": "I'm building a battery startup and want to meet climate investors.". Registering also means agreeing to their terms: "${terms}". I'll leave their mailing-list boxes unchecked. Want me to register you for this event using these details and answers, and agree to those terms?`, saved.sendThisWordForWord);
    const notTheirs = await turn("sounds right").run("saveRegistrationAnswers", { registrationId: id, answers: [{ fieldId: "registration_answers.0.value.company", value: "Acme", from: "their_words" }] });
    check("an answer that isn't in their message is refused (never inferred)", notTheirs.ok === false, notTheirs);
    // notTheirs re-asked nothing; the last ask sent is still the submit question.
    lastText = saved.sendThisWordForWord;
    const yes = await turn("yes").run("registerForEvent", { registrationId: id, theirYes: "yes" });
    check("attestation: registered after an explicit yes to the question that named the terms", yes.status === "registered", yes);
  }

  // 5. A second event with a similar question: the company carries over, the tailored answer doesn't.
  {
    const r = await turn("the climate mixer too please").run("prepareEventRegistration", { event: "Climate Founders Mixer" });
    check("second event: asks for the why again (no reuse without asking); company not asked again", r.ask === "answers" && /Why do you want to come\?/.test(r.sendThisWordForWord) && !/your company/.test(r.sendThisWordForWord) && !r.sendThisWordForWord.includes(firstAnswer), r);
  }

  // 9-10. Approval pending, waitlisted.
  {
    const r = await turn("sign me up for partner demo day").run("prepareEventRegistration", { event: "Partner Demo Day" });
    check("approval: the ask says the host approves each guest", /the host approves each guest/.test(r.sendThisWordForWord), r.sendThisWordForWord);
    const y = await turn("yes").run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("approval pending: 'Submitted, pending approval', never 'Done' or 'you're in'", y.status === "pending_approval" && y.sendThisWordForWord.startsWith("Submitted, pending approval.") && !/\bDone\b|you're in|You're registered/i.test(y.sendThisWordForWord), y);
    const w = await turn("and pitch night").run("prepareEventRegistration", { event: "Pitch Night" });
    check("waitlist: the ask says it adds them to the waitlist", /add you to the waitlist/.test(w.sendThisWordForWord), w.sendThisWordForWord);
    const wy = await turn("yes").run("registerForEvent", { registrationId: w.registrationId, theirYes: "yes" });
    check("waitlisted: said as not confirmed", wy.status === "waitlisted" && /not confirmed yet/.test(wy.sendThisWordForWord), wy);
  }

  // Paid, CAPTCHA: stop with the real link, nothing submitted.
  {
    const p = await turn("can you get me into the paid workshop").run("prepareEventRegistration", { event: "Paid Workshop" });
    check("paid: stops, says why, gives the real link", p.ok === false && p.sendThisWordForWord === "Paid Workshop isn't free (the page shows a price ($25.00)), and paid signups aren't something I do. Here's the page:\nhttps://luma.com/paid-workshop", p);
    const g = await turn("sign me up for guarded event").run("prepareEventRegistration", { event: "Guarded Event" });
    check("CAPTCHA: stops with the blocker and the real link; never bypassed", g.ok === false && /bot check/.test(g.sendThisWordForWord) && g.sendThisWordForWord.endsWith("https://luma.com/guarded"), g);
    check("paid and CAPTCHA: nothing submitted", !submitted.some((u) => /paid-workshop|guarded/.test(u)));
  }

  // Withdrawn before submit; a newer message after the yes.
  {
    const r = await turn("sign me up for slow event").run("prepareEventRegistration", { event: "Slow Event" });
    const ask = r.sendThisWordForWord;
    const t = turn("yes", ask);
    latestFromThem = new Date(clock + 30_000); // "wait, actually no" arrived after their yes
    const y = await t.run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("a newer message after the yes: not submitted, read it first", y.ok === false && /after their yes/.test(y.error) && !submitted.some((u) => /slow-event/.test(u)), y);
    const s = await turn("actually don't", ask).run("stopEventRegistration", { registrationId: r.registrationId });
    check("withdrawn: stopped before anything was submitted", s.ok && recOf("slow-event").status === "withdrawn");
    const after = await turn("yes", ask).run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("withdrawn permission: a later yes to the old ask doesn't submit", after.ok === false && !submitted.some((u) => /slow-event/.test(u)), after);
  }

  // Uncertain result: reconciled against Luma's own state before any retry, never double-submitted.
  const codeTurn = (code: string, id: string) => {
    const at = tick();
    latestFromThem = at;
    return T.continueWithCode({ userId: U, resolvedContent: "[a sign-in code for an event signup, used once and not kept]", messageArrivedAt: at.getTime() }, env, id, code);
  };
  {
    const r = await turn("ok sign me up for slow event").run("prepareEventRegistration", { event: "Slow Event" });
    const y = await turn("yes").run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("uncertain: says it isn't confirmed, never 'you're in'", y.ok === false && y.sendThisWordForWord.startsWith("I submitted the signup for Slow Event, but the page didn't confirm it") && recOf("slow-event").status === "uncertain", y);
    const y2 = await turn("yes").run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("uncertain: a second yes to the OLD ask never resubmits; it asks about a retry", submitted.filter((u) => /slow-event/.test(u)).length === 1 && y2.sendThisWordForWord?.startsWith("Still nothing confirming Slow Event."), { y2, submitted });
    const p = await turn("did it go through?").run("prepareEventRegistration", { event: "Slow Event" });
    check("uncertain: asking again offers a retry, never resubmits on its own", p.status === "uncertain" && submitted.filter((u) => /slow-event/.test(u)).length === 1, p);
    const y3 = await turn("yes", p.sendThisWordForWord).run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("uncertain: a yes to the retry is necessary, not sufficient: Luma's own state is read first (signed in), nothing submitted yet", y3.waiting === "code" && y3.sendThisWordForWord === "Before I try again, I'll check with Luma whether the first one went through. Luma sent a sign-in code to jordan@example.com. What's the code? I'll use it for this signup. Cue won't save the code." && submitted.filter((u) => /slow-event/.test(u)).length === 1, { y3, submitted });
    const c = await codeTurn("135790", r.registrationId);
    check("reconcile shows not registered: the one retry goes (attempt 2), and its own unknown result is uncertain again", submitted.filter((u) => /slow-event/.test(u)).length === 2 && recOf("slow-event").status === "uncertain" && /didn't confirm it/.test(c.text ?? ""), { c, submitted, status: recOf("slow-event").status });
  }
  {
    // A lost response: the page never answered, but Luma kept it. The retry yes leads to a reconcile that finds it: no second submit.
    const r = await turn("sign me up for lost event").run("prepareEventRegistration", { event: "Lost Event" });
    await turn("yes").run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("lost response: uncertain, though Luma's server holds it", recOf("lost-event").status === "uncertain" && srv.registrations("lost-event").length === 1);
    const p = await turn("did it work?").run("prepareEventRegistration", { event: "Lost Event" });
    await turn("yes", p.sendThisWordForWord).run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    const c = await codeTurn("246810", r.registrationId);
    check("reconcile finds it registered: said so, nothing submitted again", c.text === "You're already registered for Lost Event with jordan@example.com, so I didn't sign you up again.\nhttps://luma.com/lost-event" && submitted.filter((u) => /lost-event/.test(u)).length === 1 && srv.registrations("lost-event").length === 1 && recOf("lost-event").status === "already_registered", { c, submitted });
  }
  {
    // Reconcile can't determine it (no way to sign in on this page): no retry, and the member is told precisely.
    const r = await turn("sign me up for blind event").run("prepareEventRegistration", { event: "Blind Event" });
    await turn("yes").run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    const p = await turn("so?").run("prepareEventRegistration", { event: "Blind Event" });
    const y = await turn("yes", p.sendThisWordForWord).run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("reconcile can't tell: no retry, told precisely", y.ok === false && y.sendThisWordForWord === "I couldn't confirm whether the signup for Blind Event went through, so I won't submit it again. Luma's confirmation email to jordan@example.com, or the event page when you're signed in, will show it.\nhttps://luma.com/blind-event" && submitted.filter((u) => /blind-event/.test(u)).length === 1 && recOf("blind-event").status === "uncertain", y);
  }
  {
    // The browser dies mid-submit: after the click it is uncertain (never retried); before it, nothing was sent.
    const crashing = (clicked: boolean) => ({ ...env, driver: async () => ({ ...driver, open: async (u: string) => { const s = await driver.open(u); s.submit = async () => { throw Object.assign(new Error("Target closed"), { clicked }); }; return s; } }) });
    const r = await turn("sign me up for crash night").run("prepareEventRegistration", { event: "Crash Night" });
    const t1 = (m: string) => { const at = tick(); latestFromThem = at; const ctx = { userId: U, resolvedContent: m, recentExchange: `Cue: ${lastText}\nMember: ${m}`, messageArrivedAt: at.getTime() }; return guardTools(T.registrationTools(ctx, crashing(false), () => {}) as any, { userId: U, resolvedContent: m, dryRun: true, notDone: () => {}, recentExchange: ctx.recentExchange }) as any; };
    const before = await t1("yes").registerForEvent.execute({ registrationId: r.registrationId, theirYes: "yes" }, {});
    check("crash before the click: stopped as unreadable with the real link; nothing sent", recOf("crash-night").status === "blocked" && /couldn't read the signup form/.test(before.sendThisWordForWord), before);
    const r2 = await turn("try crash night again").run("prepareEventRegistration", { event: "Crash Night" });
    const t2 = (m: string) => { const at = tick(); latestFromThem = at; const ctx = { userId: U, resolvedContent: m, recentExchange: `Cue: ${lastText}\nMember: ${m}`, messageArrivedAt: at.getTime() }; return guardTools(T.registrationTools(ctx, crashing(true), () => {}) as any, { userId: U, resolvedContent: m, dryRun: true, notDone: () => {}, recentExchange: ctx.recentExchange }) as any; };
    const after = await t2("yes").registerForEvent.execute({ registrationId: r2.registrationId, theirYes: "yes" }, {});
    check("crash after the click: uncertain, never retried, never 'you're in'", recOf("crash-night").status === "uncertain" && /didn't confirm it/.test(after.sendThisWordForWord), after);
  }
  {
    // A Luma link they brought themselves: the same checked flow, from its page; still their explicit yes.
    const r = await turn("can you register me for this one? https://lu.ma/brought-night").run("prepareEventRegistration", { event: "https://lu.ma/brought-night" });
    check("member-brought Luma link: the whole form read first, then the same submit question", r.ok && r.ask === "submit" && /^Brought Night is on/.test(r.sendThisWordForWord), r);
    const no = await turn("sign me up for https://lu.ma/never-shared").run("prepareEventRegistration", { event: "https://lu.ma/someone-elses" });
    check("a Luma link neither sent by Cue nor shared by them is refused", no.ok === false, no);
    const y = await turn("yes").run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("member-brought link: registered on their yes", y.status === "registered", y);
  }

  // Login by emailed code: asked in the moment, used once, never kept; what sign-in revealed goes back alone, then the submit again.
  {
    const r = await turn("sign me up for members mixer").run("prepareEventRegistration", { event: "Members Mixer" });
    check("login required: not a stop; the submit question first", r.ask === "submit", r);
    const y = await turn("yes").run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("login: authorized email can't (none exists), so the member is asked for the code", y.waiting === "code" && y.sendThisWordForWord === "Luma sent a sign-in code to jordan@example.com. What's the code? I'll use it for this signup. Cue won't save the code." && recOf("members-mixer").status === "needs_member_code", y);
    check("a message that isn't a code is never caught (it flows to the ordinary reply)", CC.codeOnlyMessage("one sec") === null);
    const cr = await codeTurn("482913", r.registrationId);
    const c = cr.result as any;
    lastText = cr.text ?? lastText;
    check("login: their code signs in; the newly revealed question is the only thing asked", c.ok === false && c.sendThisWordForWord.startsWith("Signing in showed one more question.") && /Who invited you\?/.test(c.sendThisWordForWord) && !/your company/.test(c.sendThisWordForWord), c);
    check("login: the code is in no record", !JSON.stringify(rows).includes("482913"));
    const a = await turn("Sam Rivera invited me").run("saveRegistrationAnswers", { registrationId: r.registrationId, answers: [{ fieldId: "registration_answers.0.value", value: "Sam Rivera", from: "their_words" }] });
    check("revealed question answered: the submit question again (a new detail would be shared)", C.SUBMIT_QUESTION.test(a.sendThisWordForWord) && /Sam Rivera/.test(a.sendThisWordForWord), a);
  }
  // Login by emailed code with nothing new revealed: the same yes carries on after the code. Authorized email first, when it has one.
  {
    emailCode = "771144";
    const r = await turn("sign me up for plain signin").run("prepareEventRegistration", { event: "Plain Signin" });
    const y = await turn("yes").run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("code source: authorized email first; with a code there, the member isn't asked and it completes", y.status === "registered", { y, outcome: recOf("plain-signin").outcome });
    emailCode = null;
  }

  // Live submission off: the same flow on the real switch refuses.
  {
    const off = { ...env, liveSubmit: false };
    const t = (message: string) => { const ctx = { userId: U, resolvedContent: message, recentExchange: `Cue: ${lastText}\nMember: ${message}`, messageArrivedAt: tick().getTime() }; latestFromThem = new Date(ctx.messageArrivedAt); return T.registrationTools(ctx, off, () => {}) as any; };
    const finds2 = [...finds, { key: "event:demo-two", name: "Demo Two", url: "https://lu.ma/demo-two", details: null }];
    void finds2;
    const r = await t("sign me up for climate mixer").prepareEventRegistration.execute({ event: "Partner Demo Day" }, {});
    check("live off: an already-final registration still reads back", r.status === "pending_approval", r);
  }

  await browser.close();
}

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
