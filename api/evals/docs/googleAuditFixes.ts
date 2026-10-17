// Two fixes from the Google audit (Royce, 2026-10-11). Layer 1: fake Google, fake Sendblue, receipts in memory; no network.
//   1. A Google Doc Co makes keeps its Drive file ID on the delivery receipt (for a later edit of that Doc). No behavior change.
//   2. A 403 says why: the member's grant means reconnect; our Drive API not enabled is our config problem, logged, and the member
//      is told it's on our side with nothing for them to do.
//   npx tsx evals/docs/googleAuditFixes.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const GD = await import("../../src/services/googleDocs.js");
const X = await import("../../src/services/documentDelivery.js");
const R = await import("../../src/services/deliveryReceipts.js");
const D = await import("../../src/services/documentSheet.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };
const PAIR = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
process.env.GOOGLE_DOCS_TEST_USERS = PAIR.join(",");
const doc = D.resolveDocument({ title: "Venue options for the Mission dinner", note: "From today.", kind: "venue_brief", sections: [{ heading: "The shortlist", bullets: ["Alder and Ash, about 40 seated."] }], suggestions: [] });
const to = { userId: PAIR[0], firstName: "Jordan", phone: "+15550100001", zone: "America/Los_Angeles", now: new Date("2026-10-11T18:00:00Z") };

// ---------------------------------------------------------------- 1. the file ID is kept
{
  const stub: any = {
    render: async () => Buffer.alloc(2000, 1),
    cache: (_b: Buffer, n?: string) => `https://x.test/plan-file/abc/${n}`,
    send: async () => ({}),
    from: "+15550000000",
    googleToken: async () => "tok",
    uploadDoc: async () => ({ ok: true, id: "1AbCdriveFileId", link: "https://docs.google.com/document/d/1AbCdriveFileId/edit" }),
    shareDoc: async () => ({ ok: true }),
  };
  const r = await X.deliverDocument(doc, to, "google_docs", stub);
  check("the Google Doc delivery returns the Drive file ID with the link", r.ok && (r as any).driveFileId === "1AbCdriveFileId" && (r as any).link === "https://docs.google.com/document/d/1AbCdriveFileId/edit", r);
  const receipts = R.memoryReceipts();
  const rd = await X.deliverAndRecord(doc, to, { saveTo: "google_doc", askedForGoogle: true, source: "reply" }, { deliver: (d, t, target) => X.deliverDocument(d, t, target, stub), receipts, log: async () => null });
  const gdoc = receipts.all.find((x) => x.channel === "google_docs");
  check("the receipt keeps the file ID alongside the link", !!gdoc && gdoc.driveFileId === "1AbCdriveFileId" && gdoc.link === "https://docs.google.com/document/d/1AbCdriveFileId/edit", receipts.all);
  check("no behavior change: the same one delivery, the same link texted", rd.sentOk.length === 1 && rd.sentOk[0].via === "google_docs");
  const pdf = await X.recordSent(doc, { userId: PAIR[1], channel: "email", line: null, source: "test" }, receipts);
  check("anything that isn't a Google Doc has no file ID", pdf.driveFileId === null);
  const dr = src("services/deliveryReceipts.ts");
  check("it's written to and read from the drive_file_id column", /delivered_at, drive_file_id, drive_grant\)/.test(dr) && /\$18,\$19,\$20\)/.test(dr) && /r\.driveFileId \?\? null, r\.driveGrant \?\? null\]/.test(dr) && /driveFileId: x\.drive_file_id \?\? null/.test(dr));
  check("the column is added to tables made before it", /ALTER TABLE document_deliveries ADD COLUMN IF NOT EXISTS drive_file_id TEXT/.test(src("db/migrations.ts")));
}

// ---------------------------------------------------------------- 2. a 403, by cause
{
  // Google's real shapes: Drive v3 (error.errors[].reason) and the newer one (error.status, error.details[].reason).
  const disabledV3 = { error: { code: 403, message: "Google Drive API has not been used in project 123 before or it is disabled. Enable it by visiting ...", errors: [{ reason: "accessNotConfigured", domain: "usageLimits" }] } };
  const disabledNew = { error: { code: 403, status: "PERMISSION_DENIED", message: "Drive API is disabled.", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }] } };
  const scope = { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }], status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } };
  const expired = { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } };
  check("the Drive API not enabled is our config (old and new error shapes), even with PERMISSION_DENIED on it", GD.googleRefusal(403, disabledV3) === "our_config" && GD.googleRefusal(403, disabledNew) === "our_config");
  check("a missing scope or an expired grant is theirs: reconnect", GD.googleRefusal(403, scope) === "reconnect" && GD.googleRefusal(401, expired) === "reconnect" && GD.googleRefusal(403, {}) === "reconnect");
  check("a 403 for something else (a quota) is neither", GD.googleRefusal(403, { error: { message: "User rate limit exceeded.", errors: [{ reason: "userRateLimitExceeded" }] } }) === "other");

  const fake = (status: number, body: any): any => async () => ({ ok: false, status, json: async () => body });
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: any[]) => { logged.push(a.join(" ")); };
  const cfg = await GD.uploadGoogleDoc("tok", "x", "<p>x</p>", fake(403, disabledV3));
  console.error = orig;
  check("our config: the member is told it's on our side, nothing for them to do, and never to reconnect", !cfg.ok && cfg.cause === "our_config" && /ours to fix/.test(cfg.why) && /nothing they need to do/.test(cfg.why) && /never ask them to reconnect/.test(cfg.why), cfg);
  check("our config is logged as ours", logged.some((l) => /OUR CONFIG/.test(l) && /has not been used in project/.test(l)), logged);
  const re = await GD.uploadGoogleDoc("tok", "x", "<p>x</p>", fake(403, scope));
  check("their grant: reconnect Google and allow Docs", !re.ok && re.cause === "reconnect" && /reconnect Google and allow Docs/.test(re.why));
  const quota = await GD.uploadGoogleDoc("tok", "x", "<p>x</p>", fake(403, { error: { message: "User rate limit exceeded.", errors: [{ reason: "userRateLimitExceeded" }] } }));
  check("anything else never sends them to reconnect", !quota.ok && !/reconnect/.test(quota.why));

  // The words reach Co the same way as before: the delivery's why, into the tool's error.
  const stub: any = { render: async () => Buffer.alloc(10), cache: () => "", send: async () => ({}), from: "+1", googleToken: async () => "tok", uploadDoc: async () => cfg, shareDoc: async () => ({ ok: true }) };
  const via = await X.deliverDocument(doc, to, "google_docs", stub);
  check("the delivery passes our-side words through to Co unchanged", !via.ok && via.why === (cfg as any).why);
}

console.log(`google audit fixes: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
