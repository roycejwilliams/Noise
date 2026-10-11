// Fixes from the 2026-10-11 security review (Royce: "fix all"). Layer 1: no network, no database.
//   1. The co-test dashboard: a user id in a URL or body must be the signed-in tester's own, or the tester is on the team.
//   2. co-test's public pages are rate limited per visitor (trust proxy); webhooks and the signed-in dashboard are not.
//   3. Co's page readers check every redirect hop's resolved address (no bouncing to a private or internal one).
//   4. A Google Doc is opened to anyone with the link only when their own words ask to share it, never on Co's kind label alone,
//      and Co's capability text says so.
//   npx tsx evals/security/reviewFixes.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };
const read = (p: string) => fs.readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- 1. whose data a tester reaches
{
  const M = await import("../../../co-test/src/middleware/requireTesterLogin.js");
  const team = async (id: string) => id === "team-1";
  check("a tester reaches their own id", await M.mayReach("me", "me", team));
  check("a member reaches nobody else's id", !(await M.mayReach("me", "someone-else", team)));
  check("the team reaches any id (they run the tool)", await M.mayReach("team-1", "someone-else", team));
  check("no id is no access", !(await M.mayReach("me", undefined, team)));
  check("a failed team lookup is no access", !(await M.mayReach("me", "someone-else", async () => { throw new Error("db down"); })));
  const phone = read("co-test/src/routes/phone.ts");
  const routes = [...phone.matchAll(/router\.(get|post)\("(\/:user_id[^"]*)", ([^,]+),/g)];
  check("every /api/phone/:user_id route checks the id", routes.length === 4 && routes.every((m) => m[3] === 'requireOwnOrTeam("user_id")'), routes.map((m) => m[2] + " " + m[3]));
  const api = read("co-test/src/routes/api.ts");
  check("results and tag by session id check the id", /router\.get\("\/session\/:sessionId\/results", requireOwnOrTeam\("sessionId"\)/.test(api) && /router\.post\("\/session\/:sessionId\/tag", requireOwnOrTeam\("sessionId"\)/.test(api));
  check("/extract and /assess-coverage check the body's user_id before reading or writing", (api.match(/mayReach\(\(req as any\)\.testerId, user_id\)/g) ?? []).length === 2 && api.indexOf("mayReach((req as any).testerId, user_id)") < api.indexOf("buildContextSummary(user_id)") && api.lastIndexOf("mayReach((req as any).testerId, user_id)") < api.indexOf("storeTranscriptMemory(user_id"));
  check("making a throwaway user and editing the shared checklist are team only", /router\.post\("\/session", requireTeam,/.test(api) && /router\.post\("\/:item_key", requireTeam,/.test(read("co-test/src/routes/checklist.ts")));
  check("a refused id answers 404, the same as an unknown one", /status\(404\)\.json\(\{ success: false, error: "Session not found\." \}\)/.test(read("co-test/src/middleware/requireTesterLogin.ts")));
}

// ---------------------------------------------------------------- 2. rate limits on co-test
{
  const s = read("co-test/src/server.ts");
  check("co-test counts visitors behind Railway's proxy", /app\.set\("trust proxy", 1\)/.test(s));
  const at = s.indexOf('app.use(["/i", "/readout", "/google", "/mo/unsubscribe"], limiter)');
  check("the public pages are limited, before their routes are mounted", at > 0 && at < s.indexOf('app.get("/i/:code"') && at < s.indexOf('app.use("/readout"') && at < s.indexOf('app.use("/google"') && at < s.indexOf('app.use("/mo", createMoRouter())'));
  check("starting a sign-in is limited harder", /app\.use\("\/api\/login\/start", authLimiter\)/.test(s) && s.indexOf('app.use("/api/login/start", authLimiter)') < s.indexOf('app.use("/api/login", loginRouter)'));
  check("webhooks, media and the polling dashboard aren't limited", !/app\.use\([^)]*"\/(sendblue|co|luma|audio|plan-file|api\/phone)"[^)]*limiter/.test(s) && !/app\.use\(limiter\)/.test(s));
}

// ---------------------------------------------------------------- 3. readers check every hop
{
  const w = read("api/src/services/webOpportunitySearch.ts");
  const fn = w.slice(w.indexOf("export async function readPageChecked"), w.indexOf("export function pageExcerpt"));
  check("Co's page reader goes through safeFetch (every hop resolved and checked), never a blind follow", /safeFetch\(u\.toString\(\)\)/.test(fn) && !/redirect: "follow"/.test(fn) && !/\bfetch\(u/.test(fn));
  check("a refused address is no text, never a browser retry", /if \(got && "blocked" in got && got\.blocked\) return \{ text: null, gone: false \};/.test(fn));
  const b = read("api/src/services/browserRead.ts");
  check("the browser resolves the page's name and every request's before it goes", /if \(!\(await publicHost\(u\.hostname\)\)\) return null;/.test(b) && /if \(!\(await publicHost\(host\)\)\) return route\.abort\(\);/.test(b));
  const L = await import("../../src/services/linkReader.js");
  check("an internal or private address is never public", !(await L.hostIsPublic("10.0.0.5")) && !(await L.hostIsPublic("169.254.169.254")) && !(await L.hostIsPublic("127.0.0.1")) && !(await L.hostIsPublic("fd12::1")));
  const v6 = ["::ffff:7f00:1", "::ffff:127.0.0.1", "0:0:0:0:0:ffff:a00:5", "64:ff9b::a9fe:a9fe", "fec0::1", "::1", "0::1", "fe80::1%en0", "ff02::1", "::7f00:1"];
  check("review of #142: every spelling of a private IPv6 address is private (mapped hex, NAT64, site-local, multicast)", v6.every((a) => L.isPrivateAddress(a)), v6.filter((a) => !L.isPrivateAddress(a)));
  check("public addresses stay public", !L.isPrivateAddress("2606:4700:4700::1111") && !L.isPrivateAddress("::ffff:8.8.8.8") && !L.isPrivateAddress("64:ff9b::808:808") && !L.isPrivateAddress("8.8.8.8"));
  check("review of #142: a t.co link is resolved through safeFetch too", /const r = await safeFetch\(url\);/.test(read("api/src/services/eventDetails.ts")) && !/redirect: "follow"[^\n]*\n\s*return res\.url/.test(read("api/src/services/eventDetails.ts")));
  const blocked = await L.safeFetch("http://169.254.169.254/latest/meta-data/");
  check("safeFetch refuses a private address before any request", "error" in blocked && blocked.blocked === true);
}

// ---------------------------------------------------------------- 4. Doc link sharing needs their words
{
  const X = await import("../../src/services/documentDelivery.js");
  const D = await import("../../src/services/documentSheet.js");
  const yes = ["can you share it with my cofounder", "make it shareable", "send it to the venue", "so my partner can edit it", "something we can collaborate on", "so the host can see it", "we will edit it together", "give my business partner access", "forward the link to my cofounder", "email it to the venue owner", "make it editable for my team", "let the venue see it"];
  const no = ["put it in a google doc", "save it to my drive", "make me a partnership plan in google docs", "a readout as a google doc please", "I want to edit it later", "don't share it with anyone", "keep it private, don't share", "send it to me", "so I can see it", "the shared space at the venue was great", "I'm sharing a table with Ellis, make me a google doc", "share it with my cofounder. actually no, keep it private"];
  check("asking to share it with someone opens it", yes.every((t) => X.asksToShare(t)), yes.filter((t) => !X.asksToShare(t)));
  check("review of #142: a Google Doc alone, sending it to themselves, 'shared' about something else, or any 'don't share' keeps it theirs", no.every((t) => !X.asksToShare(t)), no.filter((t) => X.asksToShare(t)));
  const PAIR = ["11111111-1111-4111-8111-111111111111"];
  process.env.GOOGLE_DOCS_TEST_USERS = PAIR.join(",");
  const doc = D.resolveDocument({ title: "Partnership plan for the Mission dinner", note: "", kind: "partnership_plan", sections: [{ heading: "The plan", bullets: ["Split the room booking."] }], suggestions: [] });
  const shares: string[] = [];
  const texts: string[] = [];
  const deps: any = { render: async () => Buffer.alloc(10), cache: () => "", send: async (m: any) => { texts.push(m.content); return {}; }, from: "+1", googleToken: async () => "tok", uploadDoc: async () => ({ ok: true, id: "f1", link: "https://docs.google.com/document/d/f1/edit" }), shareDoc: async (_t: string, id: string) => { shares.push(id); return { ok: true }; } };
  const to = { userId: PAIR[0], firstName: "Jordan", phone: "+15550100001", zone: "America/Los_Angeles", now: new Date("2026-10-11T18:00:00Z") };
  const priv = await X.deliverDocument(doc, to, "google_docs", deps);
  check("a shared kind they didn't ask to share stays private, and the text says they can share it", priv.ok && (priv as any).shared === false && shares.length === 0 && /Only you can open it for now/.test(texts[0] ?? ""));
  const pub = await X.deliverDocument(doc, { ...to, shareByLink: true }, "google_docs", deps);
  check("asked to share: opened by link", pub.ok && (pub as any).shared === true && shares.join() === "f1");
  check("Co's capability text no longer says every Doc is open to anyone with the link", /theirs alone unless they ask to share it/.test(read("api/src/services/capabilities.ts")) && !/Drive, open to anyone with the link, and text the link/.test(read("api/src/services/capabilities.ts")));
  check("every delivery path passes their words, not Co's label", /shareByLink: asksToShare\(theirWords\(\)\)/.test(read("api/src/agent/loopTools.ts")) && /shareByLink: asksToShare\(o\.taskTheirWords\)/.test(read("api/src/services/documentDelivery.ts")) && /shareByLink: D\.asksToShare\(o\.task\.theirWords \?\? ""\)/.test(read("api/src/services/researchBrief.ts")));
}

console.log(`security review fixes: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
