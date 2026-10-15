// Model-free checks for partners as configuration (services/partners.ts, services/partnerCopy.ts, routes/partnerPage.ts,
// src/scripts/partners.ts): the config rules, one code per night, the code's life (not open, open, dead for good), the page a
// code opens, and that no guest-facing word ships without Royce's copy. No network, no database (the pool is stubbed).
//
//   npx tsx evals/partners/config.ts
import { readFileSync } from "fs";

const P = await import("../../src/services/partners.js");
const C = await import("../../src/services/partnerCopy.js");
const Page = await import("../../src/routes/partnerPage.js");
const { inviteCodeCandidates } = await import("../../src/services/inviteCodes.js");
const pool = (await import("../../src/db/db.js")).default as any;

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const BLURB = "Cue is making introductions at {event}. Say you're coming: {link}";

// ---------------------------------------------------------------- partner config
{
  const ok = P.checkPartner({ slug: " House-Of-AI ", name: "House of AI", rsvp_blurb: BLURB, host_email: "host@example.com", host_name: "Ellis" });
  check("partner: a good config passes, slug lowercased", ok.ok && ok.value.slug === "house-of-ai" && ok.value.host_email === "host@example.com");
  check("partner: a bad slug fails", !P.checkPartner({ slug: "house of ai", name: "x", rsvp_blurb: BLURB }).ok);
  check("partner: no name fails", !P.checkPartner({ slug: "hai", name: "  ", rsvp_blurb: BLURB }).ok);
  check("partner: a bad host email fails", !P.checkPartner({ slug: "hai", name: "HAI", rsvp_blurb: BLURB, host_email: "not-an-email" }).ok);
  check("partner: no host email is fine (the host read goes by link)", P.checkPartner({ slug: "hai", name: "HAI", rsvp_blurb: BLURB }).ok);
}
{
  check("blurb: a good one passes", P.blurbProblem(BLURB) === null);
  check("blurb: no {link} fails", /needs \{link\}/.test(P.blurbProblem("Cue is here tonight.") ?? ""));
  check("blurb: {link} twice fails", /more than once/.test(P.blurbProblem("{link} and {link}") ?? ""));
  check("blurb: an unknown placeholder fails", /\{name\}/.test(P.blurbProblem("Hi {name}, {link}") ?? ""));
  check("blurb: its own link fails (only {link})", !!P.blurbProblem("Text Cue {link} or https://evil.example"));
  check("blurb: an sms: link of its own fails", !!P.blurbProblem("{link} sms:+15550100"));
  check("blurb: 'matchmaker' fails (brand voice)", /matchmaker/.test(P.blurbProblem("Cue, our matchmaker: {link}") ?? ""));
  check("blurb: 'concierge' fails", !!P.blurbProblem("Cue, the concierge: {link}"));
  check("blurb: 'Noise's AI' fails", !!P.blurbProblem("Noise's AI will help: {link}"));
  check("blurb: over the length fails", !!P.blurbProblem(`${"x".repeat(P.PARTNER.maxBlurb)} {link}`));
}
{
  const e = P.checkPartnerEvent({ name: "Demo Night", start_at: "2026-11-06T18:00:00-08:00", end_at: "2026-11-06T22:00:00-08:00", timezone: "America/Los_Angeles" });
  check("event: a good one passes, times stored in UTC", e.ok && e.value.start_at === "2026-11-07T02:00:00.000Z" && e.value.end_at === "2026-11-07T06:00:00.000Z");
  check("event: a start with no offset is refused (never read in the server's zone)", !P.checkPartnerEvent({ name: "x", start_at: "2026-11-06T18:00:00" }).ok);
  check("event: an end with no offset is refused", !P.checkPartnerEvent({ name: "x", start_at: "2026-11-06T18:00:00Z", end_at: "2026-11-06T22:00:00" }).ok);
  check("event: an end before the start is refused", !P.checkPartnerEvent({ name: "x", start_at: "2026-11-06T18:00:00Z", end_at: "2026-11-06T17:00:00Z" }).ok);
  check("event: a 20-hour night is refused", !P.checkPartnerEvent({ name: "x", start_at: "2026-11-06T18:00:00Z", end_at: "2026-11-07T14:00:00Z" }).ok);
  check("event: a made-up zone is refused", !P.checkPartnerEvent({ name: "x", start_at: "2026-11-06T18:00:00Z", timezone: "Mars/Base" }).ok);
  check("event: a long name is refused", !P.checkPartnerEvent({ name: "x".repeat(81), start_at: "2026-11-06T18:00:00Z" }).ok);
}

// ---------------------------------------------------------------- codes
{
  let calls = 0;
  // First draw is all letters (no digit), so it's drawn again.
  const rand = (n: number) => {
    calls++;
    return Uint8Array.from({ length: n }, (_, i) => (calls === 1 ? 0 : i === 0 ? 30 : 1));
  };
  const code = P.newEntryCode(rand);
  check("code: a draw with no digit is drawn again", calls === 2 && P.isEntryCode(code));
  for (let i = 0; i < 200; i++) if (!P.isEntryCode(P.newEntryCode())) check("code: every new code is a valid entry code", false);
  check("code: six symbols, a digit and a letter", P.isEntryCode("K7Q2MX") && !P.isEntryCode("KQXMRT") && !P.isEntryCode("234567"));
  check("code: never an English word", !P.isEntryCode("THANKS") && !P.isEntryCode("CENTER"));
  check("code: no ambiguous symbols (0/O, 1/I/L)", !P.isEntryCode("K0Q2MX") && !P.isEntryCode("K1Q2MX") && !P.isEntryCode("KLQ2MX"));
  check("code: an 8-symbol invite code is never an entry code", !P.isEntryCode("6VGF76VK") && P.entryCodeCandidates("Code: 6VGF76VK").length === 0);
  check("code: found inside a text, even lowercased", P.entryCodeCandidates("hi cue it's for demo night (k7q2mx)").join() === "K7Q2MX");
  check("code: an entry text is never read as an invite code", inviteCodeCandidates("Hi Cue, it's for Demo Night (K7Q2MX)").length === 0);
}

// ---------------------------------------------------------------- the code's life
{
  const live = { ended_at: null };
  const night = { start_at: "2026-11-07T02:00:00.000Z", end_at: "2026-11-07T06:00:00.000Z", timezone: "America/Los_Angeles", intake_opened_at: null as Date | null, closed_at: null as Date | null };
  const before = new Date("2026-11-01T12:00:00Z");
  const during = new Date("2026-11-07T03:00:00Z");
  const after = new Date("2026-11-07T06:01:00Z");
  check("state: created, not opened -> not_open", P.entryState(live, night, before) === "not_open");
  check("state: opened -> open", P.entryState(live, { ...night, intake_opened_at: before }, during) === "open");
  check("state: past the end -> over, even if opened", P.entryState(live, { ...night, intake_opened_at: before }, after) === "over");
  check("state: never opened and past the end -> over (dead, never openable)", P.entryState(live, night, after) === "over");
  check("state: the room closed early -> over", P.entryState(live, { ...night, intake_opened_at: before, closed_at: during }, new Date(during.getTime() + 1000)) === "over");
  check("state: no end on file -> over after the evening (effectiveEnd)", P.entryState(live, { ...night, end_at: null, intake_opened_at: before }, new Date("2026-11-08T09:00:00Z")) === "over");
  check("state: the partner's agreement ended -> ended", P.entryState({ ended_at: before }, { ...night, intake_opened_at: before }, during) === "ended");
}

// ---------------------------------------------------------------- copy: nothing guests read without Royce
{
  check("copy: as shipped, every guest-facing line waits on Royce", C.pendingCopy().length === Object.keys(C.PARTNER_COPY).length);
  check("copy: a pending line is never shown", Object.keys(C.PARTNER_COPY).every((k) => C.copyFor(k as any, { agent: "Cue", event: "E", partner: "P", code: "K7Q2MX", next: "N" }) === null));
  const table = { ...C.PARTNER_COPY, entry_text: "Hi {agent}, {event} ({code})", page_open_terms: "Terms for {event}.", page_over: "{event} is over." } as any;
  check("copy: an approved line is filled in", C.copyFor("page_open_terms", { event: "Demo Night" }, table) === "Terms for Demo Night.");
  check("copy: a line naming something the caller can't fill is not shown", C.copyFor("page_open_terms", {}, table) === null);
  check("copy: the entry text without its code is not shown", C.copyFor("entry_text", { agent: "Cue", event: "E", code: "K7Q2MX" }, { ...table, entry_text: "Hi {agent}, {event}" }) === null);
  check("copy: the entry text with its code is", C.copyFor("entry_text", { agent: "Cue", event: "E", code: "K7Q2MX" }, table) === "Hi Cue, E (K7Q2MX)");
  check("copy: entryText is null while its copy is pending", P.entryText("Demo Night", "K7Q2MX") === null);
  // The page has no English of its own: every sentence a guest reads comes through copyFor.
  const page = src("src/routes/partnerPage.ts").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  check("copy: the page has no hard-coded sentence", !/["'`][A-Z][a-z']+ [a-z']+ [a-z']+/.test(page));
  check("copy: the services have no hard-coded guest sentence", !/["'`]Hi \$\{AGENT\}/.test(src("src/services/partners.ts")));
}

// ---------------------------------------------------------------- blurb and link
{
  const partner = { name: "House of AI", rsvp_blurb: BLURB, rsvp_blurb_approved_by: null as string | null };
  check("blurb: not handed out before its sign-off", P.renderBlurb(partner, { name: "Demo Night" }, "https://x/r/K7Q2MX") === null);
  check("blurb: signed off, it's filled in", P.renderBlurb({ ...partner, rsvp_blurb_approved_by: "Royce" }, { name: "Demo Night" }, "https://x/r/K7Q2MX") === "Cue is making introductions at Demo Night. Say you're coming: https://x/r/K7Q2MX");
  check("link: none without a public base URL", P.entryUrl("K7Q2MX", "") === null && P.entryUrl("K7Q2MX", "localhost") === null);
  check("link: the page for the code", P.entryUrl("K7Q2MX", "https://api.example.com/") === "https://api.example.com/r/K7Q2MX");
}

// ---------------------------------------------------------------- the page
{
  const partner = { id: "p1", slug: "hai", name: "House of AI", rsvp_blurb: BLURB, host_name: null, host_email: null, rsvp_blurb_approved_by: "Royce", ended_at: null };
  const ev = (o: any = {}) => ({ api_id: "partner-aa", partner_id: "p1", name: "Demo Night", start_at: "2026-11-07T02:00:00.000Z", end_at: "2026-11-07T06:00:00.000Z", timezone: "America/Los_Angeles", venue: null, address: null, code: "K7Q2MX", intake_opened_at: new Date("2026-11-01T00:00:00Z"), closed_at: null, ...o });
  const during = new Date("2026-11-07T03:00:00Z");
  const after = new Date("2026-11-07T07:00:00Z");
  const next = ev({ api_id: "partner-bb", name: "Second Night", code: "M4R8TW", start_at: "2026-12-05T02:00:00.000Z", end_at: "2026-12-05T06:00:00.000Z" });
  const opts = (event: any, o: any = {}) => ({ phone: "+15550100", now: during, resolve: async () => ({ event, partner }), next: async () => null, ...o });

  let v = await Page.partnerPageView("K7Q2MX", opts(ev()));
  check("page: live code, copy pending -> no words and no button (nobody texts in on untold terms)", v.status === 200 && v.line === null && v.button === null);
  v = await Page.partnerPageView("zzz", opts(ev()));
  check("page: not a code -> 404", v.status === 404 && v.button === null);
  v = await Page.partnerPageView("K7Q2MX", opts(ev(), { resolve: async () => null }));
  check("page: an unknown code -> 404", v.status === 404);
  v = await Page.partnerPageView("K7Q2MX", opts(ev(), { phone: "" }));
  check("page: no Cue number configured -> 500, no button", v.status === 500 && v.button === null);
  v = await Page.partnerPageView("K7Q2MX", opts(ev({ intake_opened_at: null })));
  check("page: not open yet -> no button", v.status === 200 && v.button === null);
  v = await Page.partnerPageView("K7Q2MX", opts(ev(), { now: after, next: async () => next }));
  check("page: a late scan -> 410, dead (no text to Cue offered)", v.status === 410 && !/^sms:/.test(v.button?.href ?? ""));

  // With Royce's copy in place (simulated here only), the live page opens a text with the code, and a late scan points to the
  // partner's next live night.
  const saved = { ...C.PARTNER_COPY };
  const live = C.PARTNER_COPY as any;
  Object.assign(live, { entry_text: "T {event} ({code})", page_open_terms: "terms", page_open_button: "go", page_over_next: "next is {next}", page_over_next_button: "see {next}", page_over: "over" });
  const savedUrl = process.env.API_URL;
  process.env.API_URL = "https://api.example.com";
  try {
    v = await Page.partnerPageView("k7q2mx", opts(ev()));
    check("page (copy approved): live -> a text to Cue's number with the night's code", v.button?.href === `sms:+15550100?&body=${encodeURIComponent("T Demo Night (K7Q2MX)")}` && v.line === "terms");
    v = await Page.partnerPageView("K7Q2MX", opts(ev({ intake_opened_at: null })));
    check("page (copy approved): not open -> still no button", v.button === null);
    live.page_open_terms = C.PENDING;
    v = await Page.partnerPageView("K7Q2MX", opts(ev()));
    check("page: text and label approved but the terms pending -> no button", v.button === null);
    live.page_open_terms = "terms";
    v = await Page.partnerPageView("K7Q2MX", opts(ev(), { now: after, next: async () => next }));
    check("page (copy approved): late scan -> the next night's page, never a text", v.status === 410 && v.button?.href === "https://api.example.com/r/M4R8TW" && v.line === "next is Second Night");
    v = await Page.partnerPageView("K7Q2MX", opts(ev(), { now: after }));
    check("page (copy approved): late scan, no next night -> the one line, no button", v.status === 410 && v.line === "over" && v.button === null);
    v = await Page.partnerPageView("K7Q2MX", opts(ev(), { now: during, resolve: async () => ({ event: ev(), partner: { ...partner, ended_at: new Date("2026-11-02T00:00:00Z") } }), next: async () => next }));
    check("page (copy approved): partner ended -> dead, no next night offered", v.status === 410 && v.button === null);
    const html = Page.page("<b>Demo</b>", "a \"line\"", { href: "sms:+1?&body=x", label: "go" });
    check("page: the night's name is escaped", html.includes("&lt;b&gt;Demo&lt;/b&gt;") && !html.includes("<b>Demo"));
  } finally {
    Object.assign(live, saved);
    if (savedUrl === undefined) delete process.env.API_URL;
    else process.env.API_URL = savedUrl;
  }
}

// ---------------------------------------------------------------- data (stubbed pool)
{
  const realQuery = pool.query;
  const calls: { q: string; p: any[] }[] = [];
  let conflicts = 0;
  const partnerRow = { id: "p1", slug: "hai", name: "House of AI", rsvp_blurb: BLURB, host_name: null, host_email: null, rsvp_blurb_approved_by: null, ended_at: null };
  let partnerEnded: Date | null = null;
  let codeRows: any[] = [];
  let joined: any = null;
  pool.query = async (q: string, p: any[] = []) => {
    calls.push({ q, p });
    if (/FROM partners WHERE slug/.test(q)) return { rows: [{ ...partnerRow, ended_at: partnerEnded }] };
    if (/INSERT INTO partner_events/.test(q)) {
      if (conflicts-- > 0) return { rows: [] };
      return { rows: [{ api_id: p[0], partner_id: p[1], name: p[2], start_at: p[3], end_at: p[4], timezone: p[5], venue: p[6], address: p[7], code: p[8], intake_opened_at: null, closed_at: null }] };
    }
    if (/SELECT api_id FROM partner_events WHERE code = ANY/.test(q)) return { rows: codeRows };
    if (/FROM partner_events e JOIN partners p/.test(q)) return { rows: joined ? [joined] : [] };
    if (/UPDATE partner_events SET intake_opened_at/.test(q)) return { rowCount: 1, rows: [] };
    return { rows: [], rowCount: 1 };
  };
  try {
    conflicts = 2;
    const r = await P.addPartnerEvent("hai", { name: "Demo Night", start_at: "2026-11-06T18:00:00-08:00" });
    const inserts = calls.filter((c) => /INSERT INTO partner_events/.test(c.q));
    check("event add: a taken code just takes another", r.ok && inserts.length === 3 && new Set(inserts.map((c) => c.p[8])).size >= 2);
    check("event add: its own partner- id and a valid code, not open yet", r.ok && /^partner-[0-9a-f]{16}$/.test(r.event.api_id) && P.isEntryCode(r.event.code) && r.event.intake_opened_at === null);
    check("event add: the code is unique by the table (ON CONFLICT (code))", /ON CONFLICT \(code\) DO NOTHING/.test(inserts[0]?.q ?? ""));
    partnerEnded = new Date("2026-10-01T00:00:00Z");
    check("event add: refused once the partner's agreement ended", !(await P.addPartnerEvent("hai", { name: "x", start_at: "2026-11-06T18:00:00Z" })).ok);
    partnerEnded = null;

    calls.length = 0;
    check("resolve: a text with no code never reads the table", (await P.resolveEntryCode("hi there")) === null && calls.length === 0);
    codeRows = [{ api_id: "partner-aa" }];
    joined = { api_id: "partner-aa", partner_id: "p1", name: "Demo Night", start_at: "2026-11-07T02:00:00Z", end_at: "2026-11-07T06:00:00Z", timezone: null, venue: null, address: null, code: "K7Q2MX", intake_opened_at: null, closed_at: null, id: "p1", slug: "hai", partner_name: "House of AI", rsvp_blurb: BLURB, host_name: "Ellis", host_email: "host@example.com", rsvp_blurb_approved_by: null, ended_at: null };
    codeRows = [{ api_id: "partner-aa" }, { api_id: "partner-bb" }];
    check("resolve: two nights' codes in one text -> neither is guessed", (await P.resolveEntryCode("K7Q2MX M4R8TW")) === null);
    codeRows = [{ api_id: "partner-aa" }];
    const found = await P.resolveEntryCode("Hi Cue (k7q2mx)");
    check("resolve: one code -> its night and partner, with the host read settings", found?.event.api_id === "partner-aa" && found?.partner.name === "House of AI" && found?.partner.host_email === "host@example.com");
    check("resolve: a non-partner id never reads the table", (await P.partnerEvent("evt-123")) === null);

    calls.length = 0;
    const opened = await P.openIntake("partner-aa", new Date("2026-11-01T00:00:00Z"));
    check("open: a created night opens", opened.ok && calls.some((c) => /SET intake_opened_at = NOW\(\) WHERE api_id = \$1 AND intake_opened_at IS NULL AND closed_at IS NULL/.test(c.q)));
    calls.length = 0;
    const late = await P.openIntake("partner-aa", new Date("2026-11-08T00:00:00Z"));
    check("open: a night that's over stays dead", !late.ok && /stays dead/.test(late.ok ? "" : late.why) && !calls.some((c) => /UPDATE partner_events/.test(c.q)));
    joined = { ...joined, closed_at: new Date("2026-11-01T00:00:00Z") };
    check("open: a closed night can't be reopened", !(await P.openIntake("partner-aa", new Date("2026-11-02T00:00:00Z"))).ok);

    calls.length = 0;
    await P.updatePartner("hai", { rsvp_blurb: "New words: {link}" });
    const upd = calls.find((c) => /UPDATE partners SET name/.test(c.q));
    check("blurb change: new words lose the sign-off", !!upd && /rsvp_blurb_approved_by = CASE WHEN rsvp_blurb = \$3 THEN rsvp_blurb_approved_by END/.test(upd.q));
    check("blurb sign-off: needs a name", !(await P.approveBlurb("hai", " ")).ok);
    check("update: a bad change is refused whole", !(await P.updatePartner("hai", { host_email: "nope" })).ok);
  } finally {
    pool.query = realQuery;
  }
}

// ---------------------------------------------------------------- wiring
{
  const mig = src("src/db/migrations.ts");
  const block = mig.slice(mig.indexOf("CREATE TABLE IF NOT EXISTS partners ("), mig.indexOf("partners / partner_events init failed"));
  check("tables: partners and partner_events, one unique code per night", /CREATE TABLE IF NOT EXISTS partner_events/.test(block) && /code TEXT NOT NULL UNIQUE/.test(block) && /CHECK \(api_id LIKE 'partner-%'\)/.test(block));
  check("tables: no person's data in the partner config", block.length > 0 && !/user_id|phone|first_name/.test(block));
  check("route: /r/:code on the API server", /app\.get\("\/r\/:code", servePartnerPage\)/.test(src("src/server.ts")));
  const ct = readFileSync(new URL("../../../co-test/src/server.ts", import.meta.url), "utf8");
  check("route: /r/:code on co-test too, behind its rate limit", /app\.get\("\/r\/:code", servePartnerPage\)/.test(ct) && /app\.use\(\["\/i", "\/r",/.test(ct));
  const svc = src("src/services/partners.ts");
  check("partners: sends nothing (no Sendblue, no email)", !/sendblue|resend|sendExempt|enqueueCandidate/i.test(svc.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")));
  check("partners: nothing reopens a dead night (no UPDATE clears closed_at)", !/closed_at = NULL/.test(svc));
  const script = src("src/scripts/partners.ts");
  check("script: prints the blurb only through renderBlurb (sign-off held)", /P\.renderBlurb\(partner, e, url\)/.test(script) && !/rsvp_blurb\.replace/.test(script));
  check("script: makes the door QR from the night's link", /doorQr\(e\.code, url\)/.test(script) && /QR\.toString\(url/.test(script));
}

console.log(`partners config: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
