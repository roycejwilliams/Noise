// The bounce, part 2 (Royce, 2026-10-15): calendar connect, free/busy only, its own grant (never the combined Gmail/Drive one), a plain
// grant screen first, the grant in what Cue knows, a one-tap disconnect, never shared. Zero tokens: Google and the database are stubs.
//   npx tsx evals/bounce/calendar.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.GOOGLE_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_CUE_CLIENT_ID = "test-cue-client";
process.env.GOOGLE_CUE_CLIENT_SECRET = "test-cue-secret";
process.env.API_URL = "https://api.example.test";
import { readFileSync } from "fs";

const C = await import("../../src/services/cueGrants.js");
const G = await import("../../src/services/googleAuth.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};
const FB = "https://www.googleapis.com/auth/calendar.freebusy";

// ---------------------------------------------------------------- free/busy only, its own grant
check("the grant is exactly free/busy: anything wider or else is refused", C.calendarScopesOnly(FB) && !C.calendarScopesOnly(`${FB} https://www.googleapis.com/auth/gmail.metadata`) && !C.calendarScopesOnly("https://www.googleapis.com/auth/calendar.readonly") && !C.calendarScopesOnly(""));
{
  const u = new URL(C.calendarAuthUrl("st", "ch"));
  check("Google's consent screen asks for free/busy and nothing else, never merged with an earlier grant", u.searchParams.get("scope") === FB && u.searchParams.get("include_granted_scopes") === "false");
  check("... on the calendar's own OAuth client (its own Google project), never the Gmail/Drive one", u.searchParams.get("client_id") === "test-cue-client");
  const only = { ...process.env, GOOGLE_CUE_CLIENT_ID: "", GOOGLE_CUE_CLIENT_SECRET: "" };
  check("without its own client the calendar grant is off: no fallback to the combined grant's client", !C.calendarConfigured(only) && C.calendarConfigured());
}
{
  const ga = src("services/googleAuth.ts");
  check("the combined Google grant never serves a calendar link (never reused to save time)", (ga.match(/grant_kind = 'google'/g) ?? []).length === 0 && /\? \(rows\[0\]\.grant_kind as GrantKind\) : null/.test(src("services/cueGrants.ts")));
  check("the calendar link is its own kind, with its own token table", /grant_kind\) VALUES \(\$1, \$2, \$3, NOW\(\) \+ make_interval\(secs => \$4\), \$5\)/.test(src("services/cueGrants.ts")) && /calendar: \{ scope: CALENDAR_SCOPES\[0\], table: "calendar_grants"/.test(src("services/cueGrants.ts")) && /CREATE TABLE IF NOT EXISTS calendar_grants/.test(src("db/migrations.ts")));
}

// ---------------------------------------------------------------- connect and disconnect (Google and the database are stubs)
{
  const { default: pool } = await import("../../src/db/db.js");
  const real = (pool as any).query;
  const sqls: { q: string; a: any[] }[] = [];
  const verifier = G.encryptToken("verifier-123");
  let grant: any = null;
  (pool as any).query = async (q: string, a: any[] = []) => {
    sqls.push({ q, a });
    if (/UPDATE google_oauth_states SET used_at = NOW\(\) WHERE state = \$1 AND grant_kind = \$2/.test(q)) return { rows: a[0] === "live" && a[1] === "calendar" ? [{ user_id: "u1", code_verifier_enc: verifier }] : [] };
    if (/INSERT INTO calendar_grants/.test(q)) {
      grant = { user_id: a[0], refresh: a[1], access: a[2], scope: a[4], revoke_hash: a[5] };
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT user_id FROM docs_grants WHERE revoke_hash = \$1/.test(q)) return { rows: [] };
    if (/SELECT user_id FROM calendar_grants WHERE revoke_hash = \$1/.test(q)) return { rows: grant && grant.revoke_hash === a[0] ? [{ user_id: grant.user_id }] : [] };
    if (/DELETE FROM calendar_grants WHERE user_id = \$1/.test(q)) {
      const g = grant;
      grant = null;
      return { rows: g ? [{ refresh_token_enc: g.refresh, access_token_enc: g.access }] : [] };
    }
    if (/SELECT refresh_token_enc, access_token_enc, access_expires_at > NOW\(\) AS fresh FROM calendar_grants/.test(q)) return { rows: grant ? [{ refresh_token_enc: grant.refresh, access_token_enc: grant.access, fresh: true }] : [] };
    return { rows: [], rowCount: 1 };
  };
  const calls: { url: string; body: string }[] = [];
  const googleSays = (scope: string) => (async (url: any, init?: any) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    if (/oauth2\.googleapis\.com\/token/.test(String(url))) return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope }), { status: 200 });
    if (/revoke/.test(String(url))) return new Response("", { status: 200 });
    if (/freeBusy/.test(String(url))) return new Response(JSON.stringify({ calendars: { primary: { busy: [{ start: "2026-10-20T23:00:00Z", end: "2026-10-21T00:00:00Z" }] } } }), { status: 200 });
    throw new Error("refused");
  }) as typeof fetch;
  try {
    const wide = await C.finishCalendarConnect("live", "code", googleSays(`${FB} https://www.googleapis.com/auth/gmail.metadata`));
    check("a grant wider than free/busy is revoked and never kept", !wide.ok && grant === null && calls.some((c) => /revoke/.test(c.url)));
    calls.length = 0;
    const ok = await C.finishCalendarConnect("live", "code", googleSays(FB));
    const exchange = calls.find((c) => /oauth2\.googleapis\.com\/token/.test(c.url));
    check("the code is exchanged on the calendar's own client", !!exchange && /client_id=test-cue-client/.test(exchange.body) && /client_secret=test-cue-secret/.test(exchange.body) && !/client_id=test-client&/.test(exchange.body));
    check("a free/busy grant is kept (encrypted) with a one-tap disconnect token, only its hash stored", ok.ok && !!ok.revoke && grant?.scope === FB && grant.revoke_hash !== ok.revoke && grant.refresh !== "rt" && grant.access !== "at");
    const busy = await C.calendarBusy("u1", new Date("2026-10-20T00:00:00Z"), new Date("2026-10-22T00:00:00Z"), googleSays(FB));
    check("the read is busy spans only, for this member", Array.isArray(busy) && busy.length === 1 && Object.keys(busy[0]).sort().join(",") === "end,start");
    const fbCall = calls.find((c) => /freeBusy/.test(c.url));
    check("... asked for their own primary calendar, between the two times", !!fbCall && /"id":"primary"/.test(fbCall.body) && /2026-10-20T00:00:00/.test(fbCall.body));
    check("a span is free only when nothing busy overlaps it", C.spanFree(new Date("2026-10-20T21:00:00Z"), new Date("2026-10-20T22:30:00Z"), busy!) && !C.spanFree(new Date("2026-10-20T22:30:00Z"), new Date("2026-10-20T23:30:00Z"), busy!));
    calls.length = 0;
    check("a wrong disconnect token does nothing", !(await C.disconnectByToken("not-the-token-at-all", googleSays(FB))) && grant !== null);
    const gone = await C.disconnectByToken(ok.revoke!, googleSays(FB));
    check("one tap disconnects: revoked with Google and deleted", gone && grant === null && calls.some((c) => /revoke/.test(c.url)));
    check("with no grant, no calendar gap is real (nothing to read)", (await C.calendarBusy("u1", new Date(), new Date(Date.now() + 86_400_000), googleSays(FB))) === null);
    const expired = await C.finishCalendarConnect("used", "code", googleSays(FB));
    check("an expired or used link connects nothing", !expired.ok && grant === null);
  } finally {
    (pool as any).query = real;
  }
}

// ---------------------------------------------------------------- the screen, the disconnect, what Cue knows
{
  const R = await import("../../src/routes/google.js");
  const copy = R.CALENDAR_GRANT_COPY;
  check("the grant screen says what's seen (busy or free, that's all) and what never is", /busy and when you're free/.test(copy.sees) && copy.never.some((n) => /what an event is, where it is, or who it's with/.test(n)) && copy.never.some((n) => /Never shared with anyone, including other members/.test(n)) && copy.never.some((n) => /never adds, moves or changes/.test(n)));
  check("... and how to undo it, before they ever grant", /disconnect my calendar/.test(copy.undo));
  const rt = src("routes/google.ts");
  check("Google's screen only after they choose to go on from Cue's screen", /grantKindOf\(String\(req\.params\.state\)\)/.test(rt) && /router\.get\("\/connect\/:state\/go"/.test(rt) && /grantConsentUrlFor\(kind, /.test(rt));
  check("disconnect is a button (POST), never a bare link a preview could trigger, and only for its own grant", /router\.post\(`\/\$\{kind\}\/disconnect\/:token`/.test(rt) && /<form method="post">/.test(rt) && !/router\.get\(`\/\$\{kind\}\/disconnect\/:token`, async[\s\S]{0,200}disconnectByToken/.test(rt) && /disconnectByToken\(String\(req\.params\.token\), fetch, kind\)/.test(rt));
  const K = await import("../../src/services/whatCoKnows.js");
  const items = K.knownItems({ profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], calendar: { since: "2026-10-15" } });
  const line = items.find((i) => i.ref === "grant:calendar");
  check("the grant shows in what Cue knows, in plain words, and can be removed (that disconnects)", !!line && /only when you're busy or free/.test(line.text) && /never shared/.test(line.text) && /case "grant":[\s\S]{0,400}disconnectGrant\(a, userId\)/.test(src("services/whatCoKnows.ts")));
  const tools = src("services/googleTools.ts");
  check("Cue's calendar tool sends the calendar link (never the combined Google one)", /calendarConnection: tool/.test(tools) && /createCalendarLink\(ctx\.userId\)/.test(tools.slice(tools.indexOf("calendarConnection"), tools.length)));
  const caps = src("services/capabilities.ts");
  const cal = caps.slice(caps.indexOf('id: "calendar"'), caps.indexOf('\n    id: "', caps.indexOf('id: "calendar"') + 10));
  check("what Cue says it can do: busy or free only, never shared, and it never holds a time", /never what an event is, where, or with whom/.test(cal) && /never shared with anyone, including other members/.test(cal) && /Cue never holds, books or reserves a time/.test(cal));
}

// ---------------------------------------------------------------- review of the grants work: forgetting, behaviorally
{
  const C = await import("../../src/services/cueGrants.js");
  const G = await import("../../src/services/googleAuth.js");
  const B = await import("../../src/services/bounce.js");
  const { default: pool } = await import("../../src/db/db.js");
  const real = (pool as any).query;
  const envWas = { id: process.env.GOOGLE_CUE_CLIENT_ID, sec: process.env.GOOGLE_CUE_CLIENT_SECRET, key: process.env.GOOGLE_TOKEN_KEY };
  Object.assign(process.env, { GOOGLE_CUE_CLIENT_ID: "c", GOOGLE_CUE_CLIENT_SECRET: "s", GOOGLE_TOKEN_KEY: Buffer.alloc(32, 5).toString("base64") });
  const qs: string[] = [];
  let grantRow: any = null;
  (pool as any).query = async (q: string) => {
    qs.push(q);
    if (/SELECT refresh_token_enc, access_token_enc, access_expires_at > NOW\(\) AS fresh FROM calendar_grants/.test(q)) return { rows: grantRow ? [grantRow] : [] };
    if (/DELETE FROM calendar_grants WHERE user_id = \$1 RETURNING/.test(q)) return { rows: grantRow ? [grantRow] : [] };
    if (/SELECT connected_at FROM calendar_grants/.test(q)) return { rows: grantRow ? [{ connected_at: new Date() }] : [] };
    return { rows: [], rowCount: 1 };
  };
  try {
    grantRow = { refresh_token_enc: G.encryptToken("refresh-1"), access_token_enc: null, fresh: false };
    const refused = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const tok = await C.grantToken("calendar", "u1", refused);
    check("revoked at Google (a refresh refused as invalid_grant): the grant is forgotten here, and its busy times with it",
      tok === null && qs.some((q) => /^DELETE FROM calendar_grants WHERE user_id = \$1$/.test(q.trim())) && qs.some((q) => /UPDATE google_snapshots SET busy = NULL WHERE user_id = \$1/.test(q)), qs);
    qs.length = 0;
    const ok = await C.disconnectGrant("calendar", "u1", (async () => new Response("{}")) as unknown as typeof fetch);
    check("disconnecting the calendar clears the busy times read through it", ok && qs.some((q) => /UPDATE google_snapshots SET busy = NULL WHERE user_id = \$1/.test(q)), qs);
    grantRow = null;
    const g = await B.gapNow("u1", { source: "calendar", day: "2026-10-20", from: "18:00", to: "20:00", quote: null } as any, { day: "2026-10-20", from: "18:00", to: "20:00" }, "America/Chicago");
    check("a watch on a calendar plan with the calendar disconnected is unwatchable (it ends quietly)", g === "unwatchable", g);
  } finally {
    (pool as any).query = real;
    for (const [k, v] of [["GOOGLE_CUE_CLIENT_ID", envWas.id], ["GOOGLE_CUE_CLIENT_SECRET", envWas.sec], ["GOOGLE_TOKEN_KEY", envWas.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const routes = readFileSync(new URL("../../src/routes/google.ts", import.meta.url), "utf8");
  check("an expired or used link shows Cue's page, never the old one that says 'Text Co'", /return res\.status\(410\)\.send\(calPage\("This link has expired", "<p>Text Cue and ask for a new one\.<\/p>"\)\);/.test(routes) && !/consentUrlFor|Text Co\b/.test(routes));
}

console.log(`bounce calendar: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
