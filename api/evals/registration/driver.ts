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
check("live submission is off (a code constant)", D.LUMA_LIVE_SUBMIT_APPROVED === false && !D.submitAllowed(false) && D.submitAllowed(true));
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
  // live submission off: a non-fixture driver refuses to submit
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
    check("live page: submit refused while LUMA_LIVE_SUBMIT_APPROVED is false", threw);
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
  check("page slots: every session released", open === 0, open);
  await browser.close();
}

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
