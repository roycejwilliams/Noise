// Registering a member for another host's Luma event: the pure core and the record (services/eventRegistration/registration.ts,
// registrationStore.ts). Synthetic forms shaped like Luma's public registration form (read from public event pages 2026-11-09, nothing
// submitted). Layer 1: no browser, no model, no database (a fake one that keeps rows in memory), zero tokens.
//   npx tsx evals/registration/core.ts
import * as R from "../../src/services/eventRegistration/registration.js";
import * as S from "../../src/services/eventRegistration/registrationStore.js";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };

const U = "00000000-0000-4000-8000-0000000a1109";
const facts: R.MemberFacts = { first_name: { value: "Jordan", source: "account" }, last_name: { value: "Ellis", source: "account" }, email: { value: "jordan@example.com", source: "account" } };
const f = (id: string, label: string, kind: R.FieldKind, required = true, extra: Partial<R.FormField> = {}): R.FormField => ({ id, label, kind, required, ...extra });
const base = (over: Partial<R.FormRead> = {}): R.FormRead => ({
  url: "https://lu.ma/demo-night?utm_source=cue", eventName: "Demo Night", when: "Thu Nov 20, 6:00 PM", action: "register", tickets: [], priceText: "Free",
  fields: [f("name", "Name", "name"), f("email", "Email", "email")], gate: "none", readAt: "2026-11-09T12:00:00Z", ...over,
});

// ---- field kinds, from what the page shows
check("kind: Luma's name input", R.classifyField({ label: "Name *", type: "text", name: "name", autocomplete: "name" }) === "name");
check("kind: email", R.classifyField({ label: "Email *", type: "email", name: "email" }) === "email");
check("kind: company (Luma's company question)", R.classifyField({ label: "What company do you work for?", type: "text", name: "registration_answers.0.value.company", autocomplete: "organization" }) === "company");
check("kind: job title", R.classifyField({ label: "What is your role in that company?", type: "text", name: "registration_answers.5.value.job_title", autocomplete: "organization-title" }) === "job_title");
check("kind: LinkedIn", R.classifyField({ label: "What is your LinkedIn profile?", type: "text" }) === "linkedin");
check("kind: why attend is an open question", R.classifyField({ label: "Why do you want to attend?", type: "text" }) === "open_question");
check("kind: 'who invited you?' is a short answer, never inferred", R.classifyField({ label: "who invited you?", type: "text" }) === "short_text");
check("kind: newsletter box is marketing", R.classifyField({ label: "Would you like to subscribe to the quarterly newsletter?", type: "checkbox" }) === "marketing");
check("kind: 'interested in admissions information' box is marketing", R.classifyField({ label: "Are you interested in Berkeley Master of Design admissions information?", type: "checkbox" }) === "marketing");
check("kind: event terms box is terms", R.classifyField({ label: "By registering, I agree to the event terms.", type: "checkbox", required: true }) === "terms");
check("kind: age attestation", R.classifyField({ label: "I confirm that I am over 21", type: "checkbox", required: true }) === "attestation");
check("kind: a select", R.classifyField({ label: "What category fits you best?", type: "text", options: ["Founders", "Operators"] }) === "select");

// ---- free only
check("free: 'Free'", R.freeOnly("Free").free === true);
check("paid: $10 stops", R.freeOnly("$10.00").free === false);
check("paid: a suggested donation stops", R.freeOnly("Free, suggested donation").free === false);
check("paid: a refundable deposit stops", R.freeOnly("Free with a $0 refundable deposit").free === false);
check("paid: pay what you want stops", R.freeOnly("Pay what you want").free === false);
check("unclear: no price words stops (never assumed free)", R.freeOnly(null).free === null);
check("unclear: 'Get tickets' with no price stops", R.freeOnly("Get tickets").free === null);

// ---- known fields only: straight to the one yes
{
  const plan = R.planFill(base(), facts);
  check("known fields only: nothing missing, nothing open, nothing blocking", R.readyForYes(plan) && !plan.missing.length && !plan.open.length && !plan.blockers.length, plan);
  check("known fields only: name and chosen email filled", plan.fill.map((x) => `${x.kind}=${x.value}`).join(",") === "name=Jordan Ellis,email=jordan@example.com", plan.fill);
}
// ---- missing company + a why-attend question: one combined set of asks, a draft slot for the open one
{
  const form = base({ fields: [f("name", "Name", "name"), f("email", "Email", "email"), f("q0", "What company do you work for?", "company"), f("q1", "Why do you want to attend?", "open_question")] });
  const plan = R.planFill(form, facts);
  check("missing company: listed as missing (asked, never guessed)", plan.missing.length === 1 && plan.missing[0].kind === "company", plan.missing);
  check("why attend: open, waiting on a draft", plan.open.length === 1 && plan.open[0].draft === null, plan.open);
  check("not ready for the submit question while a fact is missing", !R.readyForYes(plan));
  const withAnswers = R.planFill(form, facts, { q0: { value: "Northwind", source: "member" }, q1: { value: "I'm raising a seed round and want to meet climate investors.", source: "draft_approved" } });
  check("after their answers: ready for the submit question", R.readyForYes(withAnswers), withAnswers);
}
// ---- marketing opt-in never checked; optional fields left blank
{
  const form = base({ fields: [f("name", "Name", "name"), f("email", "Email", "email"), f("m", "Subscribe to our newsletter", "marketing", false), f("m2", "Keep me posted about future events", "marketing", true), f("o", "Your website", "website", false)] });
  const plan = R.planFill(form, facts, { m: { value: "yes", source: "member" } });
  check("marketing: never filled, even with an answer on file, even when marked required", !plan.fill.some((x) => x.kind === "marketing") && plan.leftBlank.filter((x) => x.why === "marketing").length === 2, plan);
  check("optional: left blank", plan.leftBlank.some((x) => x.fieldId === "o" && x.why === "optional"));
}
// ---- attestation needs an explicit yes, named in the ask
{
  const form = base({ fields: [f("name", "Name", "name"), f("email", "Email", "email"), f("t", "By registering, I agree to the event terms.", "terms", true, { termsText: "No recording without consent." })] });
  const plan = R.planFill(form, facts);
  check("attestation: in its own list (never auto-ticked), with the terms text", plan.attestations.length === 1 && plan.attestations[0].termsText === "No recording without consent." && !plan.fill.some((x) => x.fieldId === "t"));
  check("attestation: part of the scope their yes covers", R.scopeOf(form, plan).agrees.length === 1);
}
// ---- paid or ambiguous ticket stops; two ticket types stop; unknown field stops
check("paid: blocker", R.planFill(base({ priceText: "$25" }), facts).blockers.some((b) => b.kind === "paid"));
check("ambiguous price: blocker", R.planFill(base({ priceText: null }), facts).blockers.some((b) => b.kind === "price_unclear"));
check("two ticket types: blocker (v1 takes no ticket choice)", R.planFill(base({ tickets: [{ label: "General", priceText: "Free" }, { label: "VIP", priceText: "Free" }] }), facts).blockers.some((b) => b.kind === "ticket_choice"));
check("unknown field: blocker naming it", R.planFill(base({ fields: [f("name", "Name", "name"), f("x", "Upload a headshot", "unknown")] }), facts).blockers.some((b) => b.kind === "unsupported" && b.detail.includes("headshot")));
// ---- sign-in and verification: email code is handled, anything else stops; CAPTCHA always stops
check("login by email code: not a blocker, the plan says sign in", (() => { const p = R.planFill(base({ gate: "login", signIn: "email_code" }), facts); return p.signIn && !p.blockers.length; })());
check("login another way: blocker", R.planFill(base({ gate: "login", signIn: "other" }), facts).blockers.some((b) => b.kind === "login"));
check("verification code step: sign-in path, not a blocker", (() => { const p = R.planFill(base({ gate: "verification" }), facts); return p.signIn && !p.blockers.length; })());
check("CAPTCHA: blocker", R.planFill(base({ gate: "captcha" }), facts).blockers.some((b) => b.kind === "captcha"));
check("code in a message: one 6-digit code", R.codeIn("it's 482 913") === "482913");
check("code in a message: two candidates is no code (asked again, never guessed)", R.codeIn("482913 or 551200?") === null);
check("code in a message: a phone number isn't a code", R.codeIn("call me at 415-555-0101") === null);
check("code in a message: none", R.codeIn("got it, sending now") === null);

// ---- keys: one per member and event
check("canonical: lu.ma and luma.com are one event, tracking dropped", R.canonicalEventUrl("https://lu.ma/demo-night?utm_source=x#top") === "https://luma.com/demo-night" && R.canonicalEventUrl("https://www.luma.com/demo-night/") === "https://luma.com/demo-night");
check("canonical: a city page isn't an event", R.canonicalEventUrl("https://luma.com/sf") === null);
check("canonical: not Luma, not v1", R.canonicalEventUrl("https://partiful.com/e/abc") === null);
check("event key", R.eventKeyOf("https://lu.ma/demo-night") === "luma:demo-night");

// ---- tailored answers stay with their registration; approved facts carry over
{
  const earlier = [{ fields: [f("q0", "Company", "company"), f("q1", "Why do you want to attend?", "open_question"), f("q2", "Who invited you?", "short_text"), f("e", "Email", "email")], answers: { q0: { value: "Northwind", source: "member" as const }, q1: { value: "To meet climate investors.", source: "draft_approved" as const }, q2: { value: "Sam", source: "member" as const }, e: { value: "jordan@work.example", source: "member" as const } } }];
  const carried = R.factsFromEarlierSignups(earlier);
  check("reuse: an approved company carries over as a fact", carried.company?.value === "Northwind" && carried.company?.source === "earlier_signup");
  check("reuse: an approved chosen email carries over", carried.email?.value === "jordan@work.example");
  check("reuse: a why-attend answer and a custom answer never carry over", Object.values(carried).every((v) => v!.value !== "To meet climate investors." && v!.value !== "Sam"));
  const second = base({ url: "https://lu.ma/climate-mixer", fields: [f("name", "Name", "name"), f("email", "Email", "email"), f("c", "Company", "company"), f("w", "Why do you want to come?", "open_question")] });
  const plan = R.planFill(second, { ...facts, ...carried });
  check("second event, similar question: company proposed from the earlier signup, the why left open (asked again, no reuse)", plan.fill.some((x) => x.kind === "company" && x.value === "Northwind") && plan.open.length === 1 && plan.open[0].draft === null, plan);
}

// ---- drafts rest on their own words
{
  const words = "I'm raising a seed round for my battery startup and want to meet climate investors in SF.";
  const ok: R.Draft = { fieldId: "w", text: "I'm raising a seed round for a battery startup and want to meet climate investors.", basis: "want to meet climate investors" };
  check("draft: grounded in their words passes", R.draftProblem(ok, words) === null, R.draftProblem(ok, words));
  check("draft: a basis that isn't theirs fails", R.draftProblem({ ...ok, basis: "I love networking events" }, words) !== null);
  check("draft: invented credentials (a number) fail", R.draftProblem({ ...ok, text: "I've raised 5 rounds and want to meet climate investors." }, words) !== null);
  check("draft: an invented name fails", R.draftProblem({ ...ok, text: "I work with Sequoia and want to meet climate investors." }, words) !== null);
  check("draft: never agrees to terms", R.draftProblem({ ...ok, text: "I agree to the terms and want to meet climate investors." }, words) !== null);
}

// ---- right before the submit
{
  const form = base();
  const plan = R.planFill(form, facts);
  const scope = R.scopeOf(form, plan);
  const hash = R.scopeHash(scope);
  const asked = new Date("2026-11-09T12:00:00Z"), yes = new Date("2026-11-09T12:01:00Z");
  const rec = { status: "awaiting_yes" as R.Status, askedAt: asked, askKind: "submit" as const, scope, scopeHash: hash };
  const run = (o: Partial<Parameters<typeof R.submitCheck>[0]> = {}) => R.submitCheck({ record: rec, yesAt: yes, latestFromThemAt: yes, planNow: plan, scopeNow: scope, liveAllowed: true, ...o });
  check("submit: a yes to the submit question, same page, goes", run().go === true);
  check("submit: live submission off stops it", (run({ liveAllowed: false }) as any).why === "live_off");
  check("withdrawn before submit: stops", (run({ record: { ...rec, status: "withdrawn" } }) as any).why === "withdrawn");
  check("a newer message after the yes ('wait, actually no'): stops to read it", (run({ latestFromThemAt: new Date(yes.getTime() + 5_000) }) as any).why === "newer_message");
  check("a draft approval is not the submit: an answers ask never authorizes it", (run({ record: { ...rec, askKind: "answers" } }) as any).why === "not_asked");
  check("needs_answers never submits (answers approved, submit question not asked yet)", (run({ record: { ...rec, status: "needs_answers" } }) as any).why === "not_asked");
  check("a yes from before the ask doesn't count", (run({ yesAt: new Date(asked.getTime() - 1000), latestFromThemAt: null }) as any).why === "not_asked");
  check("already registered: never again", (run({ record: { ...rec, status: "registered" } }) as any).why === "already_final");
  check("in flight: never a second submit", (run({ record: { ...rec, status: "submitting" } }) as any).why === "in_flight");
  check("uncertain: reconcile first, never resubmit", (run({ record: { ...rec, status: "uncertain" } }) as any).why === "uncertain");
  const later = base({ when: "Fri Nov 21, 7:00 PM" });
  const c1 = run({ scopeNow: R.scopeOf(later, R.planFill(later, facts)) }) as any;
  check("terms changed materially (new time): stops, says what changed", c1.why === "changed" && c1.changes.some((x: string) => /time changed/.test(x)), c1);
  const termsAdded = base({ fields: [...form.fields, f("t", "I agree to the code of conduct", "terms", true, { termsText: "Be kind." })] });
  const c2 = run({ planNow: R.planFill(termsAdded, facts), scopeNow: R.scopeOf(termsAdded, R.planFill(termsAdded, facts)) }) as any;
  check("a new attestation since the ask: stops", c2.why === "changed" && c2.changes.some((x: string) => /new terms/.test(x)), c2);
  const paidNow = base({ priceText: "$15" });
  check("now paid: stops on the blocker", (run({ planNow: R.planFill(paidNow, facts), scopeNow: R.scopeOf(paidNow, R.planFill(paidNow, facts)) }) as any).why === "blocked");
  const signin = base({ gate: "login", signIn: "email_code" });
  check("sign-in first: stops for the code until the held session is signed in", (run({ planNow: R.planFill(signin, facts) }) as any).why === "sign_in");
  check("resuming with their code: goes from needs_member_code", run({ record: { ...rec, status: "needs_member_code" }, planNow: R.planFill(signin, facts), signedIn: true }).go === true);
  // What a sign-in revealed: only what's new goes back, and the submit question again when obligations changed.
  const revealed = base({ fields: [...form.fields, f("q", "Who invited you?", "short_text")] });
  const pr = R.planFill(revealed, facts);
  const n1 = R.newlyOutside(scope, pr, R.scopeOf(revealed, pr));
  check("revealed after sign-in: only the new question is asked", n1.ask.length === 1 && n1.ask[0].label === "Who invited you?", n1);
  const pr2 = R.planFill(revealed, facts, { q: { value: "Sam", source: "member" } });
  const n2 = R.newlyOutside(scope, pr2, R.scopeOf(revealed, pr2));
  check("revealed after sign-in: once answered, the submit question is asked again (a new detail would be shared)", n2.ask.length === 0 && n2.reaskSubmit, n2);
  const n3 = R.newlyOutside(scope, plan, scope);
  check("nothing new revealed: no re-ask", !n3.reaskSubmit && !n3.ask.length);
}

// ---- results and reconcile
check("result: registered", R.readResultText("You're In. A confirmation was sent to your email.") === "registered");
check("result: pending approval", R.readResultText("Your request has been sent. Pending approval from the host.") === "pending_approval");
check("result: waitlisted", R.readResultText("You're on the waitlist.") === "waitlisted");
check("result: already registered (Luma's documented repeat message)", R.readResultText("You have already registered for this event.") === "already_registered");
check("result: a code step's words are never success (the code step itself is read from the page's structure)", R.readResultText("Enter the code we sent to j***@example.com") === "unknown" && R.resultBlocker("Enter the code we sent")?.kind === "verification");
// Live test 2026-11-09 (luma.com/example-event): the signup succeeded, but the whole page's text, header nav included, read as blocked.
check("result: a nav 'Sign In' is never a sign-in requirement (the live collision)", R.readResultText("Skip to Content 4:02 PM PST Discover Events Sign In Hosted By Example Host You're In") === "registered" && R.readResultText("Discover Events Sign In") === "unknown");
check("result: a 'please sign in' line in the words alone is unknown, never blocked", R.readResultText("Please sign in to continue") === "unknown");
check("result: 'submitted' alone is unknown, never 'you're in'", R.readResultText("Submitted") === "unknown");
check("reconcile: unknown stays uncertain; a retry needs their yes", (R.reconcile({ state: "unknown" }) as any).retryNeedsTheirYes === true);
check("reconcile: the page now shows registered settles it", (R.reconcile({ state: "registered" }) as any).settle === "registered");

// ---- the state machine
check("states: registered is final", !R.canMove("registered", "submitting") && !R.canMove("registered", "inspected"));
check("states: uncertain can't go back to awaiting a fresh yes without reconcile", !R.canMove("uncertain", "awaiting_yes"));
check("states: a code step resumes the submit", R.canMove("needs_member_code", "submitting") && R.canMove("submitting", "needs_member_code"));
check("states: pending can become registered (a later read)", R.canMove("pending_approval", "registered"));

// ---- the record (a fake database that keeps one row per member and event)
{
  const rows = new Map<string, any>();
  let n = 0;
  const q: S.Q = {
    query: async (sql: string, a: any[] = []) => {
      if (/INSERT INTO event_registrations/.test(sql)) {
        const key = `${a[0]}|${a[1]}`;
        if (!rows.has(key)) rows.set(key, { id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, user_id: a[0], event_key: a[1], event_url: a[2], item_key: a[3], event_name: a[4], status: "inspected", answers: {}, drafts: [], attempts: 0, updated_at: new Date() });
        return { rows: [rows.get(key)] };
      }
      const byId = [...rows.values()].find((r) => r.id === a[0] && r.user_id === a[1]);
      if (/SET status = 'submitting'/.test(sql)) {
        const okFrom = /status = 'uncertain'/.test(sql) ? byId?.status === "uncertain" && byId.asked_at > byId.submit_started_at : (a[2] as string[]).includes(byId?.status);
        if (!byId || !okFrom || byId.scope_hash !== (/status = 'uncertain'/.test(sql) ? a[2] : a[3]) || byId.ask_kind !== "submit") return { rows: [] };
        Object.assign(byId, { status: "submitting", attempts: byId.attempts + 1, submit_started_at: new Date() });
        return { rows: [byId] };
      }
      if (/UPDATE event_registrations SET status = \$3/.test(sql)) {
        if (!byId || !(a[3] as string[]).includes(byId.status)) return { rows: [] };
        byId.status = a[2];
        const cols = [...sql.matchAll(/, ([a-z_]+) = \$(\d+)/g)];
        for (const [, col, i] of cols) byId[col] = typeof a[Number(i) - 1] === "string" && /^[[{]/.test(a[Number(i) - 1]) ? JSON.parse(a[Number(i) - 1]) : a[Number(i) - 1];
        return { rows: [byId] };
      }
      return { rows: [] };
    },
  };
  const one = await S.openRegistration(U, { eventKey: "luma:demo-night", eventUrl: "https://luma.com/demo-night", itemKey: "event:evt-1", eventName: "Demo Night" }, q);
  const again = await S.openRegistration(U, { eventKey: "luma:demo-night", eventUrl: "https://luma.com/demo-night", itemKey: null, eventName: "Demo Night" }, q);
  check("record: a second yes finds the same row (one per member and event)", one.id === again.id && rows.size === 1);
  const asked = await S.moveRegistration(U, one.id, "awaiting_yes", { scopeHash: "h1", askKind: "submit", askedAt: new Date() }, q);
  check("record: moved to awaiting_yes with the asked scope", asked?.status === "awaiting_yes" && asked?.scopeHash === "h1" && asked?.askKind === "submit", asked);
  const [c1, c2] = await Promise.all([S.claimSubmit(U, one.id, "h1", {}, q), S.claimSubmit(U, one.id, "h1", {}, q)]);
  check("duplicate: two racing claims on one yes get one submit", !!c1 !== !!c2, { c1: !!c1, c2: !!c2 });
  check("record: the claim counts one attempt", [...rows.values()][0].attempts === 1);
  const wrongScope = await S.moveRegistration(U, one.id, "uncertain", {}, q);
  check("record: a lost result reads as uncertain", wrongScope?.status === "uncertain");
  check("uncertain: no retry without a fresh submit ask after the first submit", (await S.claimRetry(U, one.id, "h1", q)) === null);
  const fin = await S.moveRegistration(U, one.id, "registered", { outcome: { state: "registered", link: "https://luma.com/demo-night", linkKind: "event_page", detail: null, at: "x" } }, q);
  check("record: settled to registered after a reconcile read", fin?.status === "registered");
  check("record: registered never moves back to submitting", (await S.claimSubmit(U, one.id, "h1", {}, q)) === null && (await S.moveRegistration(U, one.id, "awaiting_yes", {}, q)) === null);
  check("stale claim: a submit with no result after 5 minutes reads as uncertain", S.effectiveStatus({ status: "submitting", submitStartedAt: new Date(Date.now() - 6 * 60_000) }) === "uncertain" && S.effectiveStatus({ status: "submitting", submitStartedAt: new Date() }) === "submitting");
  check("patch SQL: placeholders follow the four fixed ones", S.patchSql({ scopeHash: "x", askKind: "submit" }).sets.join(",") === "scope_hash = $5,ask_kind = $6");
  check("table: nullable, IF NOT EXISTS, one row per member and event, removed with the member", /CREATE TABLE IF NOT EXISTS event_registrations/.test(S.REGISTRATION_TABLE_SQL) && /UNIQUE \(user_id, event_key\)/.test(S.REGISTRATION_TABLE_SQL) && /ON DELETE CASCADE/.test(S.REGISTRATION_TABLE_SQL));
}

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
