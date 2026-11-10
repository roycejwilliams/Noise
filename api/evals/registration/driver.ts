// The Luma browser driver against local fixtures (services/eventRegistration/lumaDriver.ts, evals/registration/fixtures.ts): a real
// headless Chromium, every request answered from the fixtures and anything else refused, so nothing reaches luma.com or anywhere else.
// Layer 1: no model, no database, no network, zero tokens. Without a local Chromium the browser checks print SKIP (the pure ones run).
//   npx tsx evals/registration/driver.ts
import { chromium, type Browser } from "playwright-core";
import fs from "node:fs";
import * as D from "../../src/services/eventRegistration/lumaDriver.js";
import * as R from "../../src/services/eventRegistration/registration.js";
import { NAME_EMAIL, fixtureMap, fixtureUrl, type Fixture } from "./fixtures.js";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };

// ---- pure parts
check("live submission approved (a code constant): submit allowed on a live page; the gate itself still refuses when it's off", D.LUMA_LIVE_SUBMIT_APPROVED === true && D.submitAllowed(false) && D.submitAllowed(true) && !D.submitAllowed(false, false) && D.submitAllowed(true, false));
check("driver source: no env switch for live submission", !/process\.env\.[A-Z_]*LIVE/.test(fs.readFileSync(new URL("../../src/services/eventRegistration/lumaDriver.ts", import.meta.url), "utf8")));
const real = D.pageDataFrom({ props: { pageProps: { initialData: { kind: "event", data: { event: { name: "partner demo day", start_at: "2026-11-10T23:00:00.000Z", timezone: "America/Los_Angeles" }, ticket_info: { price: null, is_free: true, is_sold_out: false, require_approval: true }, ticket_types: [{ name: "Standard", type: "free" }], registration_questions: [] } } } } });
check("page data: Luma's real shape (2026-11-09) reads as free, approval", real.free === true && real.requireApproval === true && D.priceTextOf(real) === "Free" && D.whenOf(real) === "Tue Nov 10, 3:00 PM", real);
const flex = D.pageDataFrom({ props: { pageProps: { initialData: { data: { ticket_info: { price: { cents: 1000, currency: "usd", min_cents: 0, is_flexible: true } } } } } } });
check("page data: a flexible price reads as pay-what-you-want (never free)", D.priceTextOf(flex) === "Pay what you want");
check("page data: nothing there is unknown, never free", D.priceTextOf(D.pageDataFrom(null)) === null);

// ---- the browser
let browser: Browser | null = null;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
} catch (err: any) {
  console.log(`SKIP driver browser checks: no local Chromium (${String(err?.message ?? err).split("\n")[0].slice(0, 120)})`);
}

if (browser) {
  const terms = "No recording without consent.";
  const FIX: Fixture[] = [
    { slug: "basic-free", name: "Demo Night" },
    { slug: "approval", name: "Partner Demo Day", button: "Request to Join", result: "pending" },
    { slug: "waitlist", name: "Pitch Night", button: "Join Waitlist", result: "waitlist", ticketInfo: { is_free: true, is_sold_out: true } },
    { slug: "already", name: "Demo Night II", result: "already" },
    { slug: "custom", name: "Founders Dinner", terms, fields: [...NAME_EMAIL,
      { kind: "text", name: "registration_answers.0.value.company", label: "What company do you work for?", required: true, autocomplete: "organization" },
      { kind: "text", name: "registration_answers.1.value", label: "Why do you want to attend?", required: true },
      { kind: "combo", label: "What category fits you best?", options: ["Founders", "Operators", "Investors"], required: true },
      { kind: "check", label: "Would you like to subscribe to our newsletter?" },
      { kind: "check", label: "By registering, I agree to the event terms.", required: true },
    ] },
    { slug: "paid", name: "Paid Workshop", ticketInfo: { price: { cents: 2500 }, is_free: false }, ticketTypes: [{ name: "General", type: "paid", cents: 2500 }] },
    { slug: "members-mixer", name: "Members Mixer", signIn: { code: "482913", reveals: [{ kind: "text", name: "registration_answers.0.value", label: "Who invited you?", required: true }] } },
    { slug: "captcha", name: "Guarded Event", captcha: true, button: null },
    { slug: "timeout", name: "Slow Event", result: "timeout" },
    { slug: "codestep", name: "Code Event", result: "code", code: "551200" },
  ];
  const fixtures = fixtureMap(FIX);
  let open = 0;
  const deps: D.LumaDeps = { browser: async () => browser!, slot: async () => { open++; return () => { open--; }; }, fixtures };
  const driver = D.lumaDriver(deps);
  const facts: R.MemberFacts = { first_name: { value: "Jordan", source: "account" }, last_name: { value: "Ellis", source: "account" }, email: { value: "jordan@example.com", source: "account" } };
  const submits = async (slug: string, run: (s: Awaited<ReturnType<typeof driver.open>>) => Promise<void>) => {
    const s = await driver.open(fixtureUrl({ slug }));
    try { await run(s); } finally { await s.close(); }
  };
  const record = async (s: { pageText(): Promise<string> }) => { const m = (await s.pageText()).match(/RECORD (\{.*\}) COUNT (\d+)/); return m ? { sent: JSON.parse(m[1]), count: Number(m[2]) } : null; };

  // inspect: the whole form, nothing submitted
  await submits("custom", async (s) => {
    const form = await s.read();
    check("inspect: reading the form submits nothing", (await record(s)) === null);
    const kinds = form.fields.map((f) => `${f.kind}${f.required ? "*" : ""}`).join(",");
    check("inspect: every field read with its kind and required flag", kinds === "name*,email*,company*,open_question*,select*,marketing,terms*", { kinds, form });
    check("inspect: the dropdown's options read", form.fields.find((f) => f.kind === "select")?.options?.join("|") === "Founders|Operators|Investors", form.fields);
    check("inspect: the terms text from the page's own data", form.fields.find((f) => f.kind === "terms")?.termsText === terms);
    check("inspect: event name, time and free price from the page", form.eventName === "Founders Dinner" && form.when === "Fri Nov 20, 6:00 PM" && form.priceText === "Free" && form.action === "register", form);
    const plan = R.planFill(form, facts);
    check("inspect → plan: company missing, why-attend open, select missing, terms an attestation, newsletter left blank", plan.missing.map((m) => m.kind).join(",") === "company,select" && plan.open.length === 1 && plan.attestations.length === 1 && plan.leftBlank.some((l) => l.why === "marketing"), plan);
  });
  // fill + submit: confirmed registration, marketing never ticked, only planned values sent
  {
    const s = await driver.open(fixtureUrl({ slug: "custom" }));
    const form = await s.read();
    const answers: R.Answers = {
      "registration_answers.0.value.company": { value: "Northwind", source: "member" },
      "registration_answers.1.value": { value: "To meet climate investors.", source: "draft_approved" },
      [form.fields.find((f) => f.kind === "select")!.id]: { value: "Founders", source: "member" },
    };
    const plan = R.planFill(form, facts, answers);
    check("plan: ready once answered", R.readyForYes(plan), plan);
    const values = Object.fromEntries(plan.fill.map((x) => [x.fieldId, x.value]));
    const f1 = await s.fill(values, plan.attestations.map((a) => a.fieldId));
    check("fill: every planned value placed", f1.ok, f1);
    const res = await s.submit();
    check("confirmed registration: read as registered, with the event link", res.state === "registered" && res.link === "https://luma.com/custom", res);
    const rec = await record(s);
    check("submitted once", rec?.count === 1, rec);
    check("marketing opt-in never checked; terms ticked only because they agreed", rec?.sent["Would you like to subscribe to our newsletter?"] === false && Object.entries(rec?.sent ?? {}).some(([k, v]) => k.startsWith("By registering") && v === true), rec);
    check("only the approved values went: name, email, company, why, category", rec?.sent.name === "Jordan Ellis" && rec?.sent.email === "jordan@example.com" && rec?.sent["registration_answers.0.value.company"] === "Northwind" && rec?.sent["registration_answers.1.value"] === "To meet climate investors." && Object.values(rec?.sent ?? {}).includes("Founders"), rec);
    await s.close();
  }
  // approval pending
  await submits("approval", async (s) => {
    const form = await s.read();
    check("approval: the button says Request to Join, the plan expects pending", form.action === "request" && R.planFill(form, facts).expect === "pending_approval", form);
    const plan = R.planFill(form, facts);
    await s.fill(Object.fromEntries(plan.fill.map((x) => [x.fieldId, x.value])), []);
    const r = await s.submit();
    check("approval pending: read as pending_approval, never registered", r.state === "pending_approval", r);
  });
  // waitlisted
  await submits("waitlist", async (s) => {
    const form = await s.read();
    const plan = R.planFill(form, facts);
    check("waitlist: sold out with a waitlist is not a blocker; expects waitlisted", form.action === "waitlist" && !plan.blockers.length && plan.expect === "waitlisted", { form, plan });
    await s.fill(Object.fromEntries(plan.fill.map((x) => [x.fieldId, x.value])), []);
    check("waitlisted: read as waitlisted", (await s.submit()).state === "waitlisted");
  });
  // already registered (Luma's documented repeat message)
  await submits("already", async (s) => {
    const plan = R.planFill(await s.read(), facts);
    await s.fill(Object.fromEntries(plan.fill.map((x) => [x.fieldId, x.value])), []);
    check("already registered: read as already_registered", (await s.submit()).state === "already_registered");
  });
  // paid stops before anything
  await submits("paid", async (s) => {
    const plan = R.planFill(await s.read(), facts);
    check("paid ticket: blocker from the page's own price", plan.blockers.some((b) => b.kind === "paid"), plan.blockers);
  });
  // CAPTCHA: stops, nothing clicked
  await submits("captcha", async (s) => {
    const form = await s.read();
    check("CAPTCHA: read as the captcha gate; the plan stops", form.gate === "captcha" && R.planFill(form, facts).blockers.some((b) => b.kind === "captcha"), form);
  });
  // sign-in by emailed code: wait for their code, enter it once, read what it revealed
  await submits("members-mixer", async (s) => {
    const form = await s.read();
    const plan = R.planFill(form, facts);
    check("login: Luma's email-code sign-in read as signIn, not a blocker", form.gate === "login" && form.signIn === "email_code" && plan.signIn && !plan.blockers.length, form);
    const st = await s.startSignIn("jordan@example.com");
    check("login: their chosen email starts the sign-in; the page waits for a code", st.ok && st.waitingFor === "code", st);
    const bad = await s.enterCode("000000");
    check("login: a wrong code isn't taken (never success)", !bad.ok);
    const good = await s.enterCode("482913");
    check("login: their code signs in once", good.ok, good);
    const after = await s.read();
    const p2 = R.planFill(after, facts);
    check("after sign-in: the newly revealed question is the only thing missing", p2.missing.length === 1 && p2.missing[0].label === "Who invited you?" && !p2.signIn, p2);
  });
  // a code step after submit: needs their code, never success
  await submits("codestep", async (s) => {
    const plan = R.planFill(await s.read(), facts);
    await s.fill(Object.fromEntries(plan.fill.map((x) => [x.fieldId, x.value])), []);
    const r = await s.submit();
    check("code after submit: needs their code, never registered", r.state === "needs_code", r);
    check("code after submit: their code completes it", (await s.enterCode("551200")).ok && (await s.readResult()).state === "registered");
  });
  // uncertain: nothing readable comes back
  await submits("timeout", async (s) => {
    const plan = R.planFill(await s.read(), facts);
    await s.fill(Object.fromEntries(plan.fill.map((x) => [x.fieldId, x.value])), []);
    const r = await s.submit();
    check("uncertain result: unknown (the record keeps it uncertain; nothing retried)", r.state === "unknown", r);
  });
  // A live page in a test (live submission is on now): every host refused by publicHost, so nothing ever reaches luma.com and the
  // page never loads; a submit on it can't happen.
  {
    const liveLike = D.lumaDriver({ ...deps, fixtures: undefined, publicHost: async () => false });
    let threw = false;
    try {
      const s = await liveLike.open("https://luma.com/basic-free");
      try { await s.submit(); } catch (e) { threw = e instanceof D.LiveSubmitDisabled; }
      await s.close();
    } catch {
      // Opening a live page with every host refused fails to load: also nothing submitted.
      threw = true;
    }
    check("a live page with every host refused never loads, so nothing is submitted (no network in tests)", threw);
  }

  // ---- runtime: isolation between members, Luma's own state when signed in, crashes, held sessions
  {
    const iso1 = await browser.newContext();
    const iso2 = await browser.newContext();
    const route = (c: typeof iso1) => c.route("**/*", (r) => { const k = r.request().url().replace(/\/+$/, ""); return fixtures[k] !== undefined ? r.fulfill({ status: 200, contentType: "text/html", body: fixtures[k] }) : r.abort(); });
    await route(iso1); await route(iso2);
    const p1 = await iso1.newPage(); const p2 = await iso2.newPage();
    await p1.goto(fixtureUrl({ slug: "basic-free" })); await p2.goto(fixtureUrl({ slug: "basic-free" }));
    await p1.evaluate(() => { document.cookie = "fx_email=jordan%40example.com; path=/"; localStorage.setItem("who", "jordan"); sessionStorage.setItem("who", "jordan"); });
    const seen = await p2.evaluate(() => ({ cookie: document.cookie, local: localStorage.getItem("who"), session: sessionStorage.getItem("who") }));
    check("isolation: a cookie and storage set in one member's context are not in another's (the driver opens one context per member and event)", seen.cookie === "" && seen.local === null && seen.session === null, seen);
    await iso1.close(); await iso2.close();
    check("isolation: the driver makes a fresh context per session and never reuses or stores one", /browser\.newContext\(\{ userAgent: UA/.test(fs.readFileSync(new URL("../../src/services/eventRegistration/lumaDriver.ts", import.meta.url), "utf8")) && !/storageState/.test(fs.readFileSync(new URL("../../src/services/eventRegistration/lumaDriver.ts", import.meta.url), "utf8")));
  }
  {
    // Luma's own state for their email (the external duplicate check), through a stand-in server that keeps registrations across sessions.
    const list: Fixture[] = [{ slug: "lost-reply", name: "Lost Reply Night", result: "timeout", lost: true, loginCode: "246810" }, { slug: "never-got", name: "Never Got It", result: "timeout", loginCode: "135790" }];
    const srv = (await import("./fixtures.js")).fixtureServer(list);
    const d2 = D.lumaDriver({ ...deps, fixtures: srv.fn });
    const facts2: R.MemberFacts = { first_name: { value: "Jordan", source: "account" }, last_name: { value: "Ellis", source: "account" }, email: { value: "jordan@example.com", source: "account" } };
    const s1 = await d2.open(fixtureUrl({ slug: "lost-reply" }));
    const plan = R.planFill(await s1.read(), facts2);
    await s1.fill(Object.fromEntries(plan.fill.map((x) => [x.fieldId, x.value])), []);
    const r1 = await s1.submit();
    await s1.close();
    check("lost response: the page never answers (unknown), though Luma's server kept it", r1.state === "unknown" && srv.registrations("lost-reply").length === 1, { r1, held: srv.registrations("lost-reply") });
    const s2 = await d2.open(fixtureUrl({ slug: "lost-reply" }));
    check("own state: unknown until signed in (a fresh session can't see their registration)", (await s2.ownState()).state === "unknown");
    const st = await s2.startSignIn("jordan@example.com");
    const ok = st.ok && (await s2.enterCode("246810")).ok;
    const own = await s2.ownState();
    check("reconcile: signed in with their code, Luma's page shows them registered, so nothing is submitted again", ok && own.state === "registered", { st, own });
    await s2.close();
    const s3 = await d2.open(fixtureUrl({ slug: "never-got" }));
    await s3.startSignIn("jordan@example.com");
    await s3.enterCode("135790");
    const own3 = await s3.ownState();
    check("reconcile: signed in, no registration and a register button: not registered (the only state a retry may follow)", own3.state === "not_registered", own3);
    await s3.close();
    check("own state, pure: a page with neither a state nor a register button is unknown, never 'not registered'", D.ownStateFrom("Something else entirely", false).state === "unknown" && D.ownStateFrom("You're Going", false).state === "registered" && D.ownStateFrom("Pending Approval", true).state === "pending_approval");
  }
  {
    // The browser dies mid-session: the error says whether the submit click happened, and the page slot is released.
    const solo = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    let slots = 0;
    const d3 = D.lumaDriver({ browser: async () => solo, slot: async () => { slots++; return () => { slots--; }; }, fixtures });
    const s = await d3.open(fixtureUrl({ slug: "basic-free" }));
    await s.read();
    await solo.close();
    let err: any = null;
    try { await s.submit(); } catch (e) { err = e; }
    await s.close();
    check("crash before the click: the error says nothing was clicked (nothing sent)", !!err && err.clicked === false, { msg: String(err?.message).slice(0, 80), clicked: err?.clicked });
    check("crash: the page slot is released", slots === 0, slots);
    // The shared browser is replaced after a crash, never handed out dead.
    const B = await import("../../src/services/browserRead.js");
    const b1 = await B.sharedBrowser().catch(() => null);
    if (b1) {
      await b1.close();
      await new Promise((r) => setTimeout(r, 200));
      const b2 = await B.sharedBrowser().catch(() => null);
      check("shared browser: after it dies, the next use launches a fresh one", !!b2 && b2 !== b1 && b2.isConnected(), { same: b2 === b1 });
      await B.closeBrowser();
    } else console.log("SKIP shared browser restart: browserRead couldn't launch here");
  }
  {
    // Held sessions: expired ones are closed by the sweep, and all are closed at shutdown.
    let closed = 0;
    const fake = (): any => ({ close: async () => { closed++; } });
    const t0 = Date.now();
    check("held: a session is held for its code", D.holdSession("reg-a", fake(), t0) && D.isHeld("reg-a", t0));
    D.holdSession("reg-b", fake(), t0);
    check("held: at most three at once", D.holdSession("reg-c", fake(), t0) && !D.holdSession("reg-d", fake(), t0));
    check("held: an expired hold is closed by the sweep", D.sweepHeld(t0 + D.LUMA_LIMITS.heldMs + 1) === 3 && closed === 3 && !D.isHeld("reg-a", t0 + D.LUMA_LIMITS.heldMs + 1));
    D.holdSession("reg-e", fake(), t0);
    await D.closeAllHeld();
    check("held: shutdown closes every held session", closed === 4 && D.heldCount() === 0);
  }
  {
    // The real shared browser (browserRead.ts sharedBrowser / closeBrowser), not an injected one: its idle close never ends a page held
    // for a code, and when it goes away the held sessions are dropped and reported.
    const B = await import("../../src/services/browserRead.js");
    const savedIdle = B.BROWSER_LIMITS.idleMs;
    (B.BROWSER_LIMITS as any).idleMs = 300;
    const shared = D.lumaDriver({ browser: B.sharedBrowser, slot: B.browserSlot, fixtures: fixtureMap([{ slug: "members-mixer", name: "Members Mixer", signIn: { code: "482913" } }]) });
    try {
      const s = await shared.open(fixtureUrl({ slug: "members-mixer" }));
      await s.read();
      const st = await s.startSignIn("jordan@example.com");
      D.holdSession("reg-idle", s);
      await new Promise((r) => setTimeout(r, 1_500)); // five idle periods
      const back = D.takeHeldSession("reg-idle");
      const entered = back ? await back.enterCode("482913").catch((e) => ({ ok: false, detail: String(e?.message ?? e) })) : { ok: false, detail: "not held" };
      check("held past the shared browser's idle time: the page is still open and takes the code", st.ok && entered.ok, { st, entered });
      await back?.close();
      const lost: string[][] = [];
      D.onHeldLost((ids) => lost.push(ids));
      const s2 = await shared.open(fixtureUrl({ slug: "members-mixer" }));
      await s2.read();
      await s2.startSignIn("jordan@example.com");
      D.holdSession("reg-gone", s2);
      (B.BROWSER_LIMITS as any).idleMs = savedIdle;
      await B.closeBrowser();
      await new Promise((r) => setTimeout(r, 300));
      check("the shared browser closing drops its held sessions and reports them (the caller expires those registrations)", lost.some((ids) => ids.includes("reg-gone")) && !D.isHeld("reg-gone"), lost);
      await s2.close();
    } catch (err: any) {
      if (/Executable doesn't exist|Failed to launch/i.test(String(err?.message))) console.log("SKIP shared-browser hold checks: browserRead couldn't launch here");
      else check("shared-browser hold checks ran", false, String(err?.message ?? err));
    } finally {
      (B.BROWSER_LIMITS as any).idleMs = savedIdle;
      await B.closeBrowser();
    }
  }
  {
    // Live test 2026-11-09 (luma.com/example-event): Luma's header nav carries "Sign In" on every page; a signup that succeeded was read as
    // blocked from the whole page's text. The result is read from its own region only, here with that nav on every page.
    const navFix: Fixture[] = [
      { slug: "nav-in", name: "Nav Night", nav: true, resultIn: "card" },
      { slug: "nav-pending", name: "Nav Partner Day", nav: true, resultIn: "card", button: "Request to Join", result: "pending" },
      { slug: "nav-wait", name: "Nav Pitch Night", nav: true, resultIn: "card", button: "Join Waitlist", result: "waitlist", ticketInfo: { is_free: true, is_sold_out: true } },
      { slug: "nav-unclear", name: "Nav Slow Night", nav: true, resultIn: "card", result: "timeout" },
      { slug: "nav-dialog", name: "Nav Dialog Night", nav: true },
    ];
    const dn = D.lumaDriver({ ...deps, fixtures: fixtureMap(navFix) });
    const me = { email: "jordan@example.com", name: "Jordan Ellis" };
    const run = async (slug: string) => {
      const s = await dn.open(fixtureUrl({ slug }));
      try {
        const plan = R.planFill(await s.read(), facts);
        await s.fill(Object.fromEntries(plan.fill.map((x) => [x.fieldId, x.value])), []);
        const r = await s.submit(me);
        return { r, page: await s.pageText() };
      } finally { await s.close(); }
    };
    const a = await run("nav-in");
    check("the live collision: nav 'Sign In' on the page, result 'You're In' in the RSVP card: registered, tied to them", a.page.includes("Sign In") && a.r.state === "registered" && !/not tied/.test(a.r.detail ?? ""), a);
    const b = await run("nav-pending");
    check("nav 'Sign In' + pending in the card: pending_approval", b.r.state === "pending_approval", b.r);
    const c = await run("nav-wait");
    check("nav 'Sign In' + waitlisted in the card: waitlisted", c.r.state === "waitlisted", c.r);
    const u = await run("nav-unclear");
    check("nav 'Sign In' + no answer: unknown (uncertain after the click), never blocked", u.r.state === "unknown", u.r);
    const dd = await run("nav-dialog");
    check("nav 'Sign In' + the result in the dialog: registered", dd.r.state === "registered", dd.r);
    // Pure: what counts and what doesn't.
    const base = { region: "rsvp" as const, text: "", codeInput: false, signInForm: false, formStillOpen: false, tied: false, ticket: null };
    check("pure: success words only in the page's main content are not proof (unknown)", D.resultFrom({ ...base, region: "main", text: "You're In" }, "https://luma.com/x").state === "unknown");
    check("pure: a code input in the region is the code step", D.resultFrom({ ...base, region: "dialog", codeInput: true, text: "Enter the code" }, "https://luma.com/x").state === "needs_code");
    check("pure: a sign-in form in place of the registration form is unknown (uncertain), never blocked", D.resultFrom({ ...base, region: "dialog", signInForm: true, text: "Sign in Continue with email" }, "https://luma.com/x").state === "unknown");
    check("pure: an error counts as failed only while the dialog's form is still open; otherwise unknown", D.resultFrom({ ...base, region: "dialog", formStillOpen: true, text: "Something went wrong. Please try again." }, "https://luma.com/x").state === "failed" && D.resultFrom({ ...base, region: "rsvp", text: "Something went wrong" }, "https://luma.com/x").state === "unknown");
    check("pure: a ticket link in the region is the confirmation link and ties it to them", (() => { const r = D.resultFrom({ ...base, text: "You're In", ticket: "https://luma.com/ticket/abc", tied: true }, "https://luma.com/x"); return r.state === "registered" && r.link === "https://luma.com/ticket/abc" && r.linkKind === "confirmation"; })());
    check("pure: no read at all is unknown", D.resultFrom(null, "https://luma.com/x").state === "unknown");
  }
  {
    // Luma's real registered page (captured 2026-11-09 from a registration that already existed, signed in, read only; name and email
    // redacted to Jordan Ellis / member@example.com, scripts removed). It shows BOTH "You're In … canceling your registration" and,
    // further down, an inert "Registration / Welcome, Jordan! … Register" block: a whole-page read can't tell registered from not.
    const capture = fs.readFileSync(new URL("./fixtures/luma-registered-capture.html", import.meta.url), "utf8");
    const ctx = await browser.newContext();
    await ctx.route("**/*", (r) => r.abort()); // nothing in the capture (images, fonts) leaves the browser
    const page = await ctx.newPage();
    const regionOf = async (html: string) => {
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      return (await page.evaluate(D.regionCall({ email: "member@example.com", name: "Jordan Ellis" }))) as D.RegionRead;
    };
    const r = await regionOf(capture);
    check("captured page: the result is read from the guest-status block, not the whole page", r.region === "status" && /You’re In/.test(r.text) && /canceling your registration/.test(r.text) && !/Welcome, Jordan! To join/.test(r.text) && !/Discover/.test(r.text), r);
    check("captured page: the lower 'Registration … Register' block is not a state (it's inert; no live register button)", r.registerButton === false, r);
    check("captured page: Luma's own state reads registered from the status block (ownState no longer leans on a button count)", D.ownStateFromRegion(r).state === "registered", D.ownStateFromRegion(r));
    check("captured page: a submit's result on it reads registered", D.resultFrom(r, "https://luma.com/example-event").state === "registered");
    // The same page with no registration: the status block gone and the Registration block live.
    const notYet = capture.replace(/You’re In/g, "").replace(/No longer able to attend\?[\s\S]*?registration<\/span>\.<\/div>/, "").replace(/<div inert="">(<div><div><div>Registration)/, "<div>$1");
    const n = await regionOf(notYet);
    check("captured page, not registered: no status block, a live register button: not registered", n.region !== "status" && n.registerButton === true && D.ownStateFromRegion(n).state === "not_registered", { region: n.region, registerButton: n.registerButton, own: D.ownStateFromRegion(n) });
    await ctx.close();
    // Who it's for, read from the captured page's own description.
    const dc = D.lumaDriver({ ...deps, fixtures: { "https://luma.com/example-event": capture } });
    const s = await dc.open("https://luma.com/example-event");
    const form = await s.read();
    await s.close();
    check("captured page: 'open to Stanford students and affiliates' read from its description as a restriction to confirm", (form.restrictions ?? []).includes("This event is open to Stanford students and affiliates.") && !(form.restrictions ?? []).some((x) => /Northwind/.test(x)), form.restrictions);
  }
  {
    // Review 2026-11-09: a failed or ignored submit must never read as success.
    const base: D.RegionRead = { region: "rsvp", text: "", codeInput: false, signInForm: false, formStillOpen: false, tied: true, ticket: null, registerButton: false, regionRegisterButton: false, mainHasStatus: false };
    const u = "https://luma.com/example";
    check("an open form labeled 'If you're in SF, which neighborhood?' is not a result", D.resultFrom({ ...base, region: "dialog", formStillOpen: true, text: "If you're in SF, which neighborhood? Register" }, u).state === "unknown" && R.readResultText("If you're in SF, which neighborhood?") === "unknown");
    check("'…before we see you there?' is not a result", R.readResultText("Anything we should know before we see you there?") === "unknown" && D.resultFrom({ ...base, region: "dialog", formStillOpen: true, text: "Anything we should know before we see you there?" }, u).state === "unknown");
    check("an unchanged 'Get on the waitlist' is not waitlisted", R.readResultText("Get on the waitlist") === "unknown" && D.resultFrom({ ...base, text: "Get on the waitlist" }, u, { before: "Get on the waitlist" }).state === "unknown");
    check("an unchanged 'Registration confirmed by email after approval' is not registered", R.readResultText("Registration confirmed by email after approval") === "unknown" && D.resultFrom({ ...base, text: "You're In" }, u, { before: "You're In" }).state === "unknown");
    check("an RSVP block still offering its register button hasn't answered", D.resultFrom({ ...base, text: "You're In", regionRegisterButton: true }, u).state === "unknown");
    check("an RSVP block's success that isn't tied to them (no name, email or ticket) is uncertain", D.resultFrom({ ...base, text: "You're In", tied: false }, u).state === "unknown" && D.resultFrom({ ...base, text: "You're In", tied: true }, u).state === "registered");
    check("a status block or ticket link for this event still counts", D.resultFrom({ ...base, region: "status", tied: false, text: "You’re In No longer able to attend?" }, u).state === "registered" && D.resultFrom({ ...base, tied: true, ticket: "https://luma.com/ticket/x", text: "You're In" }, u).state === "registered");
    check("'not registered' needs a live register button in this event's block AND no status anywhere in the main content", D.ownStateFromRegion({ ...base, regionRegisterButton: true, mainHasStatus: true }).state === "unknown" && D.ownStateFromRegion({ ...base, regionRegisterButton: false }).state === "unknown" && D.ownStateFromRegion({ ...base, regionRegisterButton: true }).state === "not_registered");
    const ctx = await browser.newContext();
    await ctx.route("**/*", (r) => r.abort());
    const page = await ctx.newPage();
    const read = async (html: string, title: string | null) => {
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`);
      return (await page.evaluate(D.regionCall({ email: null, name: null }, { title }))) as D.RegionRead;
    };
    // Renamed controls: the status block's own controls aren't recognized, a live Register button sits in a card.
    const renamed = await read(`<header><nav><a>Sign In</a></nav></header><main><h1>Demo Night</h1><div class="status"><div>You’re In</div><button>Leave this event</button></div><div class="rsvp-card"><button>Register</button></div></main>`, "Demo Night");
    check("renamed controls: a status line on the page means 'not registered' can't be read (unknown, no retry)", D.ownStateFromRegion(renamed).state === "unknown" && renamed.mainHasStatus === true, renamed);
    // Two events on one page: one shows this guest in, the other offers registration.
    const two = `<main><section><h2>Other Night</h2><div><div>You’re In</div><button aria-label="My Ticket">t</button><div>No longer able to attend? <span role="button">canceling your registration</span></div></div></section><section><h2>Demo Night</h2><div class="rsvp-card"><button>Register</button></div></section></main>`;
    const forDemo = await read(two, "Demo Night");
    check("several events: another event's 'You're In' is never this event's status", forDemo.region !== "status" && D.ownStateFromRegion(forDemo).state !== "registered", forDemo);
    const forOther = await read(two, "Other Night");
    check("several events: the status block of the event asked about is read as its own", forOther.region === "status" && D.ownStateFromRegion(forOther).state === "registered", forOther);
    // Review 2026-11-09: the heading must be the whole title (normalized) or contain the whole title as words; a part of it never
    // claims the block, and with no title known no block is this event's status.
    const statusUnder = (heading: string) => `<main><section><h2>${heading}</h2><div><div>You’re In</div><button aria-label="My Ticket">t</button><div>No longer able to attend? <span role="button">canceling your registration</span></div></div></section></main>`;
    const partOf = await read(statusUnder("Demo"), "Demo Night");
    check("heading: a heading that's only part of the title ('Demo' for 'Demo Night') isn't this event's status", partOf.region !== "status" && D.ownStateFromRegion(partOf).state === "unknown", partOf);
    const shorter = await read(statusUnder("Demo Night"), "Demo Night After Party");
    check("heading: a shorter event's heading ('Demo Night') never lends its status to 'Demo Night After Party'", shorter.region !== "status" && D.ownStateFromRegion(shorter).state === "unknown", shorter);
    const midWord = await read(statusUnder("Demo Nightcap"), "Demo Night");
    check("heading: the title inside another word ('Demo Nightcap') isn't a match", midWord.region !== "status", midWord);
    const exact = await read(statusUnder("Demo Night!"), "demo night");
    check("heading: the same title, case and punctuation aside, is a match", exact.region === "status" && D.ownStateFromRegion(exact).state === "registered", exact);
    const contains = await read(statusUnder("Demo Night · Hosted by Northwind"), "Demo Night");
    check("heading: a heading containing the whole title is a match", contains.region === "status", contains);
    const untitled = await read(statusUnder("Demo Night"), null);
    check("heading: no title known: no block is accepted as this event's status (unknown)", untitled.region !== "status" && D.ownStateFromRegion(untitled).state === "unknown", untitled);
    await ctx.close();
  }
  check("page slots: every session released", open === 0, open);
  await browser.close();
}

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
