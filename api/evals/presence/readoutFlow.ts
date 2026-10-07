// The partner readout, preview to full (services/partnerReadoutSend.ts, routes/readout.ts). Model-free, against a fake database.
//   npx tsx evals/presence/readoutFlow.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.API_URL = "https://test.copatible.com";
import fs from "node:fs";
import { createHash } from "node:crypto";
const { default: pool } = await import("../../src/db/db.js");
const S = await import("../../src/services/partnerReadoutSend.js");
const R = await import("../../src/services/partnerReadout.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };

type Handler = [RegExp, (sql: string, p: any[]) => any];
const log: { sql: string; p: any[] }[] = [];
let handlers: Handler[] = [];
(pool as any).query = async (sql: string, p: any[] = []) => {
  log.push({ sql, p });
  for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, p);
  return { rows: [], rowCount: 0 };
};
const reset = (h: Handler[]) => { log.length = 0; handlers = h; };
const ran = (re: RegExp) => log.some((l) => re.test(l.sql));
const NOW = new Date("2026-10-08T20:00:00Z");
const stats: any = { eventName: "Founders Night", registered: 24, arrived: 18, walkins: 2, briefs: 20, nudged: 14, interested: 9, intros: 4, debriefReplies: 11, metSomeone: 8, conversationsTold: 13, followThroughMembers: 5, askCount: 16, themes: { "Investors or funding": 6, "Hiring or talent": 4, "Cofounders or partners": 2, "Something else": 4 } };
const MEMBERS = ["Priya", "Shah", "Jordan", "Ellis", "Noor", "Hope", "Will"];
const deps = (o: any = {}): any => ({ gather: async () => o.stats ?? stats, names: async () => o.names ?? MEMBERS });

// ---- when a draft is due
check("a draft is due 12 hours after the event ends, and not after a week", S.readoutDue({ start_at: "2026-10-07T02:00:00Z", end_at: "2026-10-07T05:00:00Z" }, NOW) && !S.readoutDue({ start_at: "2026-10-08T02:00:00Z", end_at: "2026-10-08T12:00:00Z" }, NOW) && !S.readoutDue({ start_at: "2026-09-20T02:00:00Z", end_at: "2026-09-20T05:00:00Z" }, NOW));
check("an event with no end time is taken as four hours long", S.readoutDue({ start_at: "2026-10-08T03:00:00Z", end_at: null }, NOW) && !S.readoutDue({ start_at: "2026-10-08T06:00:00Z", end_at: null }, NOW));

// ---- the leak check: nothing that could point at a member
check("a member's name in the readout is a leak", S.readoutLeak("Priya came and met 3 people.", "Founders Night", MEMBERS) === "a member's name (Priya)");
check("an email, a phone number or a link is a leak", S.readoutLeak("write to a@b.co", "X", []) === "an email address" && S.readoutLeak("call 415 555 0123", "X", []) === "a phone number" && S.readoutLeak("see https://x.test", "X", []) === "a link");
check("the event's own name is not a leak (a member named in it is the host's title, shown by design)", S.readoutLeak(R.renderText({ ...stats, eventName: "Dinner with Noor" }), "Dinner with Noor", MEMBERS) === null);
check("a name that is one of the readout's own fixed words (Will, Hope) can't block every readout", S.readoutLeak(R.renderText(stats), "Founders Night", ["Few", "Else", "Hope", "Will", "Members"]) === null);
check("the real readout text passes", S.readoutLeak(R.renderText(stats), "Founders Night", MEMBERS) === null);

// ---- drafting
{
  reset([[/SELECT \* FROM partner_readouts WHERE event_id/, () => ({ rows: [] })], [/INSERT INTO partner_readouts/, () => ({ rows: [{ id: "r1" }] })]]);
  const r = await S.draftReadout("ev1", "Founders Night", deps());
  const ins = log.find((l) => /INSERT INTO partner_readouts/.test(l.sql))!;
  check("a draft stores the frozen counts, the text and the page, as a draft (the insert sets no status, so it defaults to draft)", r.status === "drafted" && ins.p[0] === "ev1" && JSON.parse(ins.p[2]).registered === 24 && /about 25 members were registered/.test(ins.p[3]) && /<html|<table|<div/i.test(ins.p[4]) && !/status/.test(ins.sql.split("VALUES")[0]));
  check("the stored readout carries no member name, no quote, no email, phone or link", !MEMBERS.some((n) => new RegExp(`\\b${n}\\b`).test(ins.p[3])) && !/@|https?:/.test(ins.p[3]));
  reset([[/SELECT \* FROM partner_readouts WHERE event_id/, () => ({ rows: [] })]]);
  check("a room too small to read out gets no draft at all", (await S.draftReadout("ev1", "Founders Night", deps({ stats: { ...stats, registered: 5 } }))).status === "too_small" && !ran(/INSERT INTO partner_readouts/));
  reset([[/SELECT \* FROM partner_readouts WHERE event_id/, () => ({ rows: [] })]]);
  const leaky = await S.draftReadout("ev1", "Founders Night", deps({ stats: { ...stats, eventName: "Founders Night with Priya" } }));
  check("a page that would carry a member's name stores nothing", leaky.status === "leak" && /Priya/.test(leaky.why ?? "") && !ran(/INSERT INTO partner_readouts/));
  reset([[/SELECT \* FROM partner_readouts WHERE event_id/, () => ({ rows: [{ status: "approved" }] })]]);
  check("an event with a readout already is never re-drafted (what the team approved stays frozen)", (await S.draftReadout("ev1", "Founders Night", deps())).status === "exists" && !ran(/INSERT INTO partner_readouts/));
}

// ---- the hourly job drafts and tells the team; it never approves or sends
{
  const told: string[] = [];
  const row = { event_id: "ev1", text: R.renderText(stats) };
  let drafted = false;
  reset([[/SELECT \* FROM partner_readouts WHERE event_id/, () => ({ rows: drafted ? [row] : [] })], [/INSERT INTO partner_readouts/, () => { drafted = true; return { rows: [{ id: "r1" }] }; }]]);
  const n = await S.runReadoutDrafts(NOW, { ...deps(), notify: async (s: string, t: string) => { told.push(`${s}\n${t}`); }, events: async () => [{ api_id: "ev1", name: "Founders Night", start_at: "2026-10-07T02:00:00Z", end_at: "2026-10-07T05:00:00Z" }, { api_id: "ev2", name: "Tomorrow", start_at: "2026-10-09T02:00:00Z", end_at: null }] });
  check("the job drafts only events that are due, and tells the team it's ready and that nothing went to the host", n === 1 && told.length === 1 && /Nothing has gone to the host/.test(told[0]) && /approve ev1/.test(told[0]));
  check("the job never approves or sends", !ran(/SET status = 'approved'|SET status = 'sent'/));
  const svc = src("services/partnerReadoutSend.ts");
  const job = svc.slice(svc.indexOf("export async function runReadoutDrafts"), svc.indexOf("// The team's yes."));
  check("structurally too: the draft job calls no approve or send, and the cron runs only the draft job", !/approveReadout|sendReadout|deps\.email/.test(job) && /runReadoutDrafts/.test(src("jobs/index.ts")) && !/sendReadout|approveReadout/.test(src("jobs/index.ts")));
}

// ---- the team's yes
{
  reset([[/UPDATE partner_readouts SET status = 'approved'/, () => ({ rows: [{ id: "r1" }] })]]);
  const a = await S.approveReadout("ev1", { by: "Royce", hostEmail: "host@venue.test", now: NOW });
  const upd = log.find((l) => /SET status = 'approved'/.test(l.sql))!;
  const token = a.ok ? a.link.split("/readout/")[1] : "";
  check("approval: only from a draft, and gives a link on Co's own address", a.ok && /WHERE event_id = \$1 AND status = 'draft'/.test(upd.sql) && a.link.startsWith("https://test.copatible.com/readout/"));
  check("approval: the link's token is kept only as its hash", upd.p[3] === createHash("sha256").update(token).digest("hex") && !upd.p.includes(token) && token.length >= 30);
  check("approval: the link lasts 30 days", Math.round((new Date(upd.p[4]).getTime() - NOW.getTime()) / 86_400_000) === 30);
  check("approval: who said yes and the host's address are recorded", upd.p[1] === "Royce" && upd.p[2] === "host@venue.test");
  reset([]);
  check("approval needs a person's name", !(await S.approveReadout("ev1", { by: " " })).ok && !ran(/UPDATE partner_readouts/));
  check("approval refuses a host address that isn't an email", !(await S.approveReadout("ev1", { by: "Royce", hostEmail: "not an email" })).ok && !ran(/UPDATE partner_readouts/));
  reset([[/UPDATE partner_readouts SET status = 'approved'/, () => ({ rows: [] })]]);
  check("approval of something that isn't a draft (already approved, sent, withdrawn) does nothing", !(await S.approveReadout("ev1", { by: "Royce" })).ok);
}

// ---- the one email: only approved, only to the address given, only by a person
{
  const row = (o: any = {}) => ({ id: "r1", event_id: "ev1", event_name: "Founders Night", stats, text: R.renderText(stats), html: R.renderHtml(stats), status: "approved", host_email: "host@venue.test", link_expires_at: new Date("2026-11-01T00:00:00Z"), ...o });
  const emails: any[] = [];
  const mail = (ok = true) => ({ email: async (to: string, subject: string, html: string) => { emails.push({ to, subject, html }); return ok; } });
  for (const [label, r] of [["a draft (the team hasn't said yes)", row({ status: "draft" })], ["approved with no host address", row({ host_email: null })], ["withdrawn", row({ status: "withdrawn" })], ["already sent", row({ status: "sent" })], ["approved but the link expired", row({ link_expires_at: new Date("2026-10-01T00:00:00Z") })]] as const) {
    reset([[/SELECT \* FROM partner_readouts WHERE event_id/, () => ({ rows: [r] })], [/SET status = 'sent'/, () => ({ rows: [{ id: "r1" }] })]]);
    emails.length = 0;
    const res = await S.sendReadout("ev1", mail(), NOW);
    check(`send refused: ${label}; nothing emailed`, !res.ok && emails.length === 0 && !ran(/SET status = 'sent'/));
  }
  reset([[/SELECT \* FROM partner_readouts WHERE event_id/, () => ({ rows: [row()] })], [/SET status = 'sent'/, () => ({ rows: [{ id: "r1" }] })]]);
  emails.length = 0;
  const ok = await S.sendReadout("ev1", mail(), NOW);
  check("send: an approved readout goes once, to the address the team gave, as the frozen page", ok.ok && emails.length === 1 && emails[0].to === "host@venue.test" && emails[0].html === row().html && /How Founders Night went/.test(emails[0].subject));
  check("send: claimed before the email, so two runs can't send it twice", log.findIndex((l) => /SET status = 'sent'/.test(l.sql)) >= 0);
  reset([[/SELECT \* FROM partner_readouts WHERE event_id/, () => ({ rows: [row()] })], [/SET status = 'sent'/, () => ({ rows: [] })]]);
  emails.length = 0;
  check("send: another run already claimed it, nothing more is emailed", !(await S.sendReadout("ev1", mail(), NOW)).ok && emails.length === 0);
  reset([[/SELECT \* FROM partner_readouts WHERE event_id/, () => ({ rows: [row()] })], [/SET status = 'sent'/, () => ({ rows: [{ id: "r1" }] })]]);
  const failedSend = await S.sendReadout("ev1", mail(false), NOW);
  check("send: an email that didn't go is put back to approved, never marked sent", !failedSend.ok && ran(/SET status = 'approved', sent_at = NULL/));
}

// ---- the host's link: read-only, live only while approved or sent
{
  const token = "a".repeat(32);
  const h = createHash("sha256").update(token).digest("hex");
  const row = (o: any = {}) => ({ id: "r1", stats, html: "<html>page</html>", status: "approved", link_expires_at: new Date("2026-11-01T00:00:00Z"), ...o });
  reset([[/WHERE link_token_hash = \$1/, (_s, p) => ({ rows: p[0] === h ? [row()] : [] })]]);
  const got = await S.readoutByToken(token, NOW);
  check("the link opens the frozen page and the same lines as data, looked up by the token's hash", got?.html === "<html>page</html>" && /about 25 members/.test(got?.lines.join(" ") ?? "") && log[0].p[0] === h);
  check("a wrong token opens nothing", (await S.readoutByToken("b".repeat(32), NOW)) === null);
  check("a malformed token is refused before any read", (await S.readoutByToken("../../etc", NOW)) === null && log.length === 2);
  for (const [label, r] of [["a draft", row({ status: "draft" })], ["withdrawn", row({ status: "withdrawn" })], ["expired", row({ link_expires_at: new Date("2026-10-01T00:00:00Z") })]] as const) {
    reset([[/WHERE link_token_hash = \$1/, () => ({ rows: [r] })]]);
    check(`the link opens nothing when the readout is ${label}`, (await S.readoutByToken(token, NOW)) === null);
  }
  reset([]);
  await S.withdrawReadout("ev1");
  check("withdrawing clears the link's hash, so the old link can never match again", ran(/SET status = 'withdrawn', withdrawn_at = NOW\(\), link_token_hash = NULL/));
}

// ---- the route, over HTTP
{
  const express = (await import("express")).default;
  const { createReadoutRouter } = await import("../../src/routes/readout.js");
  const app = express();
  app.use("/readout", createReadoutRouter());
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const token = "c".repeat(32);
  const h = createHash("sha256").update(token).digest("hex");
  reset([[/WHERE link_token_hash = \$1/, (_s, p) => ({ rows: p[0] === h ? [{ id: "r1", stats, html: "<html>the page</html>", status: "sent", link_expires_at: new Date(Date.now() + 86_400_000) }] : [] })]]);
  const page = await fetch(`http://127.0.0.1:${port}/readout/${token}`);
  const body = await page.text();
  check("route: a live link serves the page, never cached or indexed", page.status === 200 && body === "<html>the page</html>" && page.headers.get("cache-control") === "no-store" && /noindex/.test(page.headers.get("x-robots-tag") ?? ""));
  const j = await fetch(`http://127.0.0.1:${port}/readout/${token}.json`).then((r) => r.json());
  check("route: the same readout as data (headline, lines, note), nothing more", Object.keys(j).sort().join() === "headline,lines,note" && /Founders Night/.test(j.headline));
  const miss = await fetch(`http://127.0.0.1:${port}/readout/${"d".repeat(32)}`);
  check("route: an unknown link is a plain 404", miss.status === 404 && !/Founders/.test(await miss.text()));
  const post = await fetch(`http://127.0.0.1:${port}/readout/${token}`, { method: "POST" });
  check("route: read-only (nothing but GET)", post.status === 404);
  server.close();
  check("both servers mount it", /app\.use\("\/readout", createReadoutRouter\(\)\)/.test(src("server.ts")) && /app\.use\("\/readout", createReadoutRouter\(\)\)/.test(fs.readFileSync(new URL("../../../co-test/src/server.ts", import.meta.url), "utf8")));
}

// ---- the readout service itself still has no send path; the only send is the team's script
check("partnerReadout.ts (the counts) still has no mail or text code", !/Resend|sendblue|emails\.send/i.test(src("services/partnerReadout.ts").replace(/\/\/.*$/gm, "")));
check("the send service never texts anyone (email to the team-given host only)", !/sendblue/i.test(src("services/partnerReadoutSend.ts").replace(/\/\/.*$/gm, "")));

console.log(`partner readout flow: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
