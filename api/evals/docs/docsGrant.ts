// Google Docs on its own grant (Royce, 2026-10-15): "drive.file gets its own grant in the published project, same pattern as the
// calendar split." Drive files only, on Cue's own client, a plain grant screen first, the grant in what Cue knows, a one-tap disconnect
// that touches only this grant. Zero tokens: Google and the database are stubs.
//   npx tsx evals/docs/docsGrant.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.GOOGLE_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.GOOGLE_CUE_CLIENT_ID = "test-cue-client";
process.env.GOOGLE_CUE_CLIENT_SECRET = "test-cue-secret";
process.env.API_URL = "https://api.example.test";
import { readFileSync } from "fs";

const C = await import("../../src/services/cueGrants.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};
const DF = "https://www.googleapis.com/auth/drive.file";

// ---------------------------------------------------------------- its own grant, on Cue's own client
{
  const u = new URL(C.grantAuthUrl("docs", "st", "ch"));
  check("Google's consent screen asks for drive.file and nothing else, never merged with an earlier grant", u.searchParams.get("scope") === DF && u.searchParams.get("include_granted_scopes") === "false");
  check("... on Cue's own client, never the combined grant's", u.searchParams.get("client_id") === "test-cue-client");
  check("without Cue's client the Docs grant is off: no fallback to the combined grant's client", !C.docsConfigured({ ...process.env, GOOGLE_CUE_CLIENT_ID: "", GOOGLE_CUE_CLIENT_SECRET: "" }) && C.docsConfigured());
  check("its own token table", /CREATE TABLE IF NOT EXISTS docs_grants/.test(src("db/migrations.ts")) && /docs: \{ scope: DOCS_SCOPES\[0\], table: "docs_grants"/.test(src("services/cueGrants.ts")));
}

// ---------------------------------------------------------------- connect and disconnect (Google and the database are stubs)
{
  const { default: pool } = await import("../../src/db/db.js");
  const real = (pool as any).query;
  const G = await import("../../src/services/googleAuth.js");
  const verifier = G.encryptToken("verifier-123");
  const grants: Record<string, any> = { calendar_grants: null, docs_grants: null };
  const states: { kind: string }[] = [];
  (pool as any).query = async (q: string, a: any[] = []) => {
    if (/FROM users WHERE id = \$1 AND invite_verified = true AND archived_at IS NULL/.test(q)) return { rows: a[0] === "u-guest" ? [] : [{ x: 1 }] };
    if (/INSERT INTO google_oauth_states/.test(q)) {
      states.push({ kind: a[4] });
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE google_oauth_states SET used_at = NOW\(\) WHERE state = \$1 AND grant_kind = \$2/.test(q)) return { rows: a[0] === "live-docs" && a[1] === "docs" ? [{ user_id: "u1", code_verifier_enc: verifier }] : [] };
    const ins = q.match(/INSERT INTO (\w+_grants)/);
    if (ins) {
      grants[ins[1]] = { user_id: a[0], refresh: a[1], access: a[2], scope: a[4], revoke_hash: a[5] };
      return { rows: [], rowCount: 1 };
    }
    const sel = q.match(/SELECT user_id FROM (\w+_grants) WHERE revoke_hash = \$1/);
    if (sel) return { rows: grants[sel[1]] && grants[sel[1]].revoke_hash === a[0] ? [{ user_id: grants[sel[1]].user_id }] : [] };
    const del = q.match(/DELETE FROM (\w+_grants) WHERE user_id = \$1 RETURNING/);
    if (del) {
      const g = grants[del[1]];
      grants[del[1]] = null;
      return { rows: g ? [{ refresh_token_enc: g.refresh, access_token_enc: g.access }] : [] };
    }
    const tok = q.match(/SELECT refresh_token_enc, access_token_enc, access_expires_at > NOW\(\) AS fresh FROM (\w+_grants)/);
    if (tok) return { rows: grants[tok[1]] ? [{ refresh_token_enc: grants[tok[1]].refresh, access_token_enc: grants[tok[1]].access, fresh: true }] : [] };
    return { rows: [], rowCount: 1 };
  };
  const calls: { url: string; body: string }[] = [];
  const googleSays = (scope: string) => (async (url: any, init?: any) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    if (/oauth2\.googleapis\.com\/token/.test(String(url))) return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope }), { status: 200 });
    if (/revoke/.test(String(url))) return new Response("", { status: 200 });
    throw new Error("refused");
  }) as typeof fetch;
  try {
    const link = await C.createDocsLink("u1");
    check("the Docs link is its own kind of one-time link", !!link && /\/google\/connect\//.test(link) && states.at(-1)?.kind === "docs");
    const n = states.length;
    const guestDocs = await C.createDocsLink("u-guest");
    const guestCal = await C.createCalendarLink("u-guest");
    check("grant screens are member-only, in the grant code itself: a non-member (applicant, guest, partner guest, archived) gets no link", guestDocs === null && guestCal === null && states.length === n);
    const wide = await C.finishGrantConnect("docs", "live-docs", "code", googleSays(`${DF} https://www.googleapis.com/auth/drive`));
    check("a grant wider than drive.file is revoked and never kept", !wide.ok && grants.docs_grants === null && calls.some((c) => /revoke/.test(c.url)));
    const notCal = await C.finishGrantConnect("calendar", "live-docs", "code", googleSays(DF));
    check("a Docs link can't finish as a calendar grant (the kind is bound to the link)", !notCal.ok && grants.calendar_grants === null);
    calls.length = 0;
    const ok = await C.finishGrantConnect("docs", "live-docs", "code", googleSays(DF));
    const exchange = calls.find((c) => /oauth2\.googleapis\.com\/token/.test(c.url));
    check("a drive.file grant is kept (encrypted) with a one-tap disconnect token, only its hash stored", ok.ok && !!ok.revoke && grants.docs_grants?.scope === DF && grants.docs_grants.revoke_hash !== ok.revoke && grants.docs_grants.refresh !== "rt");
    check("the code is exchanged on Cue's own client", !!exchange && /client_id=test-cue-client/.test(exchange.body) && /client_secret=test-cue-secret/.test(exchange.body));
    check("the token Docs are made with comes from this grant", (await C.docsToken("u1")) === "at");
    check("the calendar's disconnect page can't disconnect Docs", (await C.disconnectByToken(ok.revoke!, googleSays(DF), "calendar")) === null && grants.docs_grants !== null);
    const gone = await C.disconnectByToken(ok.revoke!, googleSays(DF), "docs");
    check("one tap disconnects Docs: revoked with Google and deleted", gone === "docs" && grants.docs_grants === null && calls.some((c) => /revoke/.test(c.url)));
    check("with no grant there's no Docs token (the PDF goes instead)", (await C.docsToken("u1")) === null);
  } finally {
    (pool as any).query = real;
  }
}

// ---------------------------------------------------------------- the screen, what Cue knows, what Cue says it can do
{
  const R = await import("../../src/routes/google.js");
  const copy = R.DOCS_GRANT_COPY;
  check("the grant screen says what's done (saves what Cue makes, sees only those) and what never is", /see only those/.test(copy.sees) && copy.never.some((n) => /Never anything else in your Drive/.test(n)) && copy.never.some((n) => /never shares a Doc/.test(n)));
  check("... and how to undo it, before they ever grant", /disconnect Google Docs/.test(copy.undo));
  const K = await import("../../src/services/whatCoKnows.js");
  const items = K.knownItems({ profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], docs: { since: "2026-10-15" } } as any);
  const line = items.find((i) => i.ref === "grant:docs");
  check("the grant shows in what Cue knows, in plain words, and removing it disconnects only that grant", !!line && /see only those/.test(line.text) && /if \(a !== "calendar" && a !== "docs"\)/.test(src("services/whatCoKnows.ts")) && K.fieldFor("grant:docs") === "their Google Docs connection");
  const tools = src("services/googleTools.ts");
  check("Cue's Docs tool sends the Docs link (never the combined Google one)", /docsConnection: tool/.test(tools) && /createDocsLink\(ctx\.userId\)/.test(tools.slice(tools.indexOf("docsConnection: tool"))));
  const caps = src("services/capabilities.ts");
  const docs = caps.slice(caps.indexOf('id: "docs"'), caps.indexOf("// The lines Co doesn't cross"));
  check("what Cue says it can do: Drive files it makes only, never shared by Cue, gated on Cue's client", /sees only the files it creates there, never anything else in their Drive/.test(docs) && /GOOGLE_CUE_CLIENT_ID/.test(docs) && /tool: "docsConnection"/.test(docs));
  check("the old combined Google connection (Gmail) is gone from the registry", !/id: "google"|googleConnection/.test(caps));
}

// ---------------------------------------------------------------- the moment: never before a document is made (Royce, 2026-10-15)
{
  const X = await import("../../src/services/documentDelivery.js");
  const { googleTools } = await import("../../src/services/googleTools.js");
  const asked: string[] = [];
  const db = (rows: any[]) => ({ query: async (q: string, a: any[] = []) => (asked.push(q), /FROM document_deliveries/.test(q) && a[0] === "u1" && (a[1] as string[]).includes("partnership_plan") ? { rows } : { rows: [] }) });
  check("no document made for them yet: the Docs moment hasn't come", !(await X.docsMomentReached("u1", db([]), {})));
  check("a document that could be a Google Doc has been made: the moment has come", await X.docsMomentReached("u1", db([{ "?column?": 1 }]), {}));
  check("... and only kinds that can become a Google Doc count (a personal PDF never opens the ask)", /kind = ANY\(\$2::text\[\]\)/.test(asked.at(-1) ?? ""));
  check("Docs not open to them (the narrowing list): never the moment", !(await X.docsMomentReached("u1", db([{ x: 1 }]), { GOOGLE_DOCS_TEST_USERS: "22222222-2222-4222-8222-222222222222" })));
  const sent: string[] = [];
  const notDone: string[] = [];
  const ctx = { userId: "u1", phoneNumber: "+15550100001", dryRun: false, sendCoReply: async (m: any) => { sent.push(m.message); return true; } };
  const { default: pool } = await import("../../src/db/db.js");
  const real = (pool as any).query;
  const links: string[] = [];
  (pool as any).query = async (q: string) => (/INSERT INTO google_oauth_states/.test(q) && links.push(q), /FROM users WHERE id = \$1 AND invite_verified = true AND archived_at IS NULL/.test(q) ? { rows: [{ x: 1 }] } : { rows: [], rowCount: 1 });
  try {
    const early = await (googleTools(ctx, (t) => notDone.push(t), { docsMoment: async () => false }).docsConnection as any).execute({ action: "connect" }, {});
    check("asked before any document: no link made, none sent, and Cue is told not to offer it", early.ok === false && links.length === 0 && sent.length === 0 && /Don't send a link or offer it now/.test(early.error) && /no document has been made/.test(notDone.at(-1) ?? ""));
    const now = await (googleTools(ctx, (t) => notDone.push(t), { docsMoment: async () => true }).docsConnection as any).execute({ action: "connect" }, {});
    check("once a document is being made: the one-time link goes, as its own text", now.ok === true && links.length === 1 && sent.length === 1 && /\/google\/connect\//.test(sent[0]));
    const status = await (googleTools(ctx, () => {}, { docsMoment: async () => false }).docsConnection as any).execute({ action: "status" }, {});
    check("status and disconnect are never held back by the moment", status.ok === true);
  } finally {
    (pool as any).query = real;
  }
}

// ---------------------------------------------------------------- the old combined grant: no member path, ever (Royce, 2026-10-15)
{
  const ct = src("agent/conversationTools.ts");
  check("no Gmail tool exists for anyone: the Google tools are the calendar and Docs only", !/googleConnection/.test(ct + src("services/googleTools.ts") + src("services/capabilities.ts")));
}

// ---------------------------------------------------------------- what Cue knows: removing the Docs grant disconnects it
{
  const K = await import("../../src/services/whatCoKnows.js");
  const { default: pool } = await import("../../src/db/db.js");
  const real = (pool as any).query;
  const realFetch = globalThis.fetch;
  const G = await import("../../src/services/googleAuth.js");
  let grant: any = { refresh: G.encryptToken("rt"), access: G.encryptToken("at") };
  const revoked: string[] = [];
  (pool as any).query = async (q: string) => {
    if (/DELETE FROM docs_grants WHERE user_id = \$1 RETURNING/.test(q)) { const g = grant; grant = null; return { rows: g ? [{ refresh_token_enc: g.refresh, access_token_enc: g.access }] : [] }; }
    return { rows: [], rowCount: 1 };
  };
  globalThis.fetch = (async (url: any, init?: any) => (revoked.push(String(init?.body ?? "")), new Response("", { status: 200 }))) as typeof fetch;
  try {
    const raw: any = { profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], docs: { since: "2026-10-15" } };
    const item = K.knownItems(raw).find((i) => i.ref === "grant:docs")!;
    const out: any = await K.applyOne({ query: async () => ({ rows: [], rowCount: 1 }) }, "u1", raw, item, "remove", null, "forget my google docs");
    check("removing it in what Cue knows revokes it with Google and deletes it", out.ref === "grant:docs" && out.now === null && grant === null && revoked.some((b) => /token=rt/.test(b)));
    let notApplied = false;
    await K.applyOne({ query: async () => ({ rows: [], rowCount: 1 }) }, "u1", raw, item, "remove", null, "forget it").catch(() => (notApplied = true));
    check("removing it again (already gone) isn't claimed as a change", notApplied);
    const cal = K.knownItems({ ...raw, docs: null, calendar: { since: "2026-10-15" } }).find((i) => i.ref === "grant:calendar");
    check("the calendar grant sits on the same surface, the same way", !!cal && cal.source === "grant" && item.source === "grant" && cal.group === item.group);
  } finally {
    (pool as any).query = real;
    globalThis.fetch = realFetch;
  }
}

console.log(`docs grant: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
