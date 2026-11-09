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
import { NAME_EMAIL, fixtureMap, type Fixture } from "./fixtures.js";
import { fakeRegistrations } from "./fakeStore.js";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 900)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ---- today: nothing exists for members, nothing in any prompt changes
check("approvals: live submission and copy both unapproved (code constants)", A.LUMA_LIVE_SUBMIT_APPROVED === false && A.REGISTRATION_COPY_APPROVED === false && !A.registrationLive());
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
    { slug: "slow-event", name: "Slow Event", result: "timeout" },
  ];
  const fixtures = fixtureMap(FIX);
  const submitted: string[] = [];
  const realDriver = D.lumaDriver({ browser: async () => browser!, slot: async () => () => {}, fixtures });
  // Counts every submit any session makes, by event: the duplicate checks read it.
  const driver = { ...realDriver, open: async (url: string) => { const s = await realDriver.open(url); const sub = s.submit; s.submit = async () => { submitted.push(url); return sub(); }; return s; } };
  const finds = FIX.map((f) => ({ key: `event:${f.slug}`, name: f.name!, url: `https://lu.ma/${f.slug}`, details: { startAt: "2026-11-21T02:00:00.000Z", timezone: "America/Los_Angeles", hosts: [] } }));
  const { q, rows } = fakeRegistrations(() => new Date(clock));
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

  // Uncertain result: reconciled before any retry, never double-submitted.
  {
    const r = await turn("ok sign me up for slow event").run("prepareEventRegistration", { event: "Slow Event" });
    const y = await turn("yes").run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("uncertain: says it isn't confirmed, never 'you're in'", y.ok === false && y.sendThisWordForWord.startsWith("I submitted the signup for Slow Event, but the page didn't confirm it") && recOf("slow-event").status === "uncertain", y);
    const y2 = await turn("yes").run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("uncertain: a second yes to the OLD ask never resubmits; it asks about a retry", submitted.filter((u) => /slow-event/.test(u)).length === 1 && y2.sendThisWordForWord?.startsWith("Still nothing confirming Slow Event."), { y2, submitted });
    const p = await turn("did it go through?").run("prepareEventRegistration", { event: "Slow Event" });
    check("uncertain: asking again offers a retry, never resubmits on its own", p.status === "uncertain" && submitted.filter((u) => /slow-event/.test(u)).length === 1, p);
    const y3 = await turn("yes", p.sendThisWordForWord).run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("uncertain: only a yes to the retry question submits once more", submitted.filter((u) => /slow-event/.test(u)).length === 2 && recOf("slow-event").attempts === 2, { y3, submitted });
  }

  // Login by emailed code: asked in the moment, used once, never kept; what sign-in revealed goes back alone, then the submit again.
  {
    const r = await turn("sign me up for members mixer").run("prepareEventRegistration", { event: "Members Mixer" });
    check("login required: not a stop; the submit question first", r.ask === "submit", r);
    const y = await turn("yes").run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("login: authorized email can't (none exists), so the member is asked for the code", y.waiting === "code" && y.sendThisWordForWord === "Luma sent a sign-in code to jordan@example.com. What's the code? I'll use it once and won't keep it." && recOf("members-mixer").status === "needs_member_code", y);
    const none = await turn("one sec").run("useRegistrationCode", { registrationId: r.registrationId });
    check("no code in their message: asked again, never guessed", none.ok === false && none.sendThisWordForWord === C.noCodeSeen);
    const c = await turn("482913").run("useRegistrationCode", { registrationId: r.registrationId });
    check("login: their code signs in; the newly revealed question is the only thing asked", c.ok === false && c.sendThisWordForWord.startsWith("Signing in showed one more question.") && /Who invited you\?/.test(c.sendThisWordForWord) && !/your company/.test(c.sendThisWordForWord), c);
    check("login: the code was taken out of the stored thread and is in no record", redacted.includes("482913") && !JSON.stringify(rows).includes("482913"));
    const a = await turn("Sam Rivera invited me").run("saveRegistrationAnswers", { registrationId: r.registrationId, answers: [{ fieldId: "registration_answers.0.value", value: "Sam Rivera", from: "their_words" }] });
    check("revealed question answered: the submit question again (a new detail would be shared)", C.SUBMIT_QUESTION.test(a.sendThisWordForWord) && /Sam Rivera/.test(a.sendThisWordForWord), a);
  }
  // Login by emailed code with nothing new revealed: the same yes carries on after the code. Authorized email first, when it has one.
  {
    emailCode = "771144";
    const r = await turn("sign me up for plain signin").run("prepareEventRegistration", { event: "Plain Signin" });
    const y = await turn("yes").run("registerForEvent", { registrationId: r.registrationId, theirYes: "yes" });
    check("code source: authorized email first; with a code there, the member isn't asked and it completes", y.status === "registered", y);
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
