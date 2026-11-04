// Model-free checks for Google Calendar (Gmail was removed 2026-11-04) (services/googleAuth.ts,
// googleData.ts, googleTools.ts, routes/google.ts): shared token helpers,
// encryption, owner scoping, and what Cue gets to see. Google responses are mocked; no credentials needed.
//
//   npx tsx evals/google/rules.ts
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const A = await import("../../src/services/googleAuth.js");
const D = await import("../../src/services/googleData.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const auth = src("services/googleAuth.ts");
const data = src("services/googleData.ts");

// ------------------------------------------------ no Gmail, no combined grant
const noComments = (t: string) => t.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
check("no Gmail scope or API call anywhere in the shared helpers, the reader or the tools", !/gmail/i.test(noComments(auth + data + src("services/googleTools.ts"))));
check("the old combined-grant flow is gone: no scope list, no consent URL, no connect link, no Gmail-only tool", !/GOOGLE_SCOPES|authUrl|createConnectLink|finishConnect|googleConnection/.test(auth + data + src("services/googleTools.ts") + src("routes/google.ts")));
check("the shared helpers still serve the calendar and Docs grants", typeof A.encryptToken === "function" && typeof A.revokeToken === "function" && typeof A.pkcePair === "function" && typeof A.tokenAndBaseReady === "function");
const env = { GOOGLE_TOKEN_KEY: randomBytes(32).toString("base64"), API_URL: "https://test.copatible.com" } as any;
check("the redirect goes back to co-test", A.redirectUri(env) === "https://test.copatible.com/google/callback");
const p = A.pkcePair();
check("PKCE challenge is the SHA-256 of the verifier", p.challenge === createHash("sha256").update(p.verifier).digest("base64url") && p.verifier.length >= 43);

// ------------------------------------------------ encryption at rest
const key = randomBytes(32);
const sealed = A.encryptToken("1//refresh-token-secret", key);
check("tokens round-trip through AES-256-GCM", A.decryptToken(sealed, key) === "1//refresh-token-secret");
check("the stored form never contains the token", !sealed.includes("refresh-token-secret") && sealed.startsWith("v1."));
check("same token encrypts differently each time", A.encryptToken("x", key) !== A.encryptToken("x", key));
let tamperThrew = false;
try {
  const parts = sealed.split(".");
  A.decryptToken([parts[0], parts[1], parts[2], Buffer.from("tampered").toString("base64")].join("."), key);
} catch {
  tamperThrew = true;
}
check("a tampered token is rejected", tamperThrew);
let wrongKeyThrew = false;
try {
  A.decryptToken(sealed, randomBytes(32));
} catch {
  wrongKeyThrew = true;
}
check("the wrong key can't read it", wrongKeyThrew);
check("a snapshot query is for one member", (data.match(/(FROM|INTO|UPDATE) google_snapshots[\s\S]{0,300}?\[/g) ?? []).every((q) => /user_id = \$1|VALUES \(\$1/.test(q)));
check("reads are logged as decisions", /decision: "google\.read"/.test(data));

// ------------------------------------------------ reading (mocked Google)
const now = new Date("2026-09-28T19:00:00Z");
const json = (body: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);
const fbFetch = ((url: string, init: any) => {
  const body = JSON.parse(init.body);
  return json({ calendars: { primary: { busy: [{ start: "2026-09-29T16:00:00Z", end: "2026-09-29T17:30:00Z" }] } }, _asked: body });
}) as any;
// Busy times come from their calendar grant (services/cueGrants.ts; Royce 2026-10-15: "rewire busy-times to read from the new calendar
// grant"), never the old connection: a member with only the calendar grant gets busy times, and Gmail's token never reads a calendar.
const busy = await (async () => {
  const { default: pool } = await import("../../src/db/db.js");
  const real = (pool as any).query;
  const G = await import("../../src/services/googleAuth.js");
  const keyWas = process.env.GOOGLE_TOKEN_KEY;
  process.env.GOOGLE_TOKEN_KEY = env.GOOGLE_TOKEN_KEY;
  const saved: any[] = [];
  const freeBusyAuth: string[] = [];
  (pool as any).query = async (q: string, a: any[] = []) => {
    if (/SELECT connected_at FROM calendar_grants/.test(q)) return { rows: [{ connected_at: new Date("2026-10-15T00:00:00Z") }] };
    if (/FROM calendar_grants WHERE user_id = \$1/.test(q)) return { rows: [{ refresh_token_enc: null, access_token_enc: G.encryptToken("cal-tok"), fresh: true }] };
    if (/INSERT INTO google_snapshots/.test(q)) return (saved.push(a), { rows: [], rowCount: 1 });
    return { rows: [], rowCount: 1 };
  };
  try {
    const f = ((url: string, init: any) => (/freeBusy/.test(url) && freeBusyAuth.push(String(init?.headers?.Authorization)), fbFetch(url, init))) as any;
    await D.refreshGoogleSnapshot("u1", f, now);
    check("busy times are read through their calendar grant (its own token), with no old Google connection", freeBusyAuth.join() === "Bearer cal-tok" && saved.length === 1 && saved[0].length === 2);
    return JSON.parse(saved[0]?.[1] ?? "null");
  } finally {
    (pool as any).query = real;
    if (keyWas === undefined) delete process.env.GOOGLE_TOKEN_KEY;
    else process.env.GOOGLE_TOKEN_KEY = keyWas;
  }
})();
check("free/busy is read for the primary calendar", JSON.stringify(busy) === JSON.stringify([{ start: "2026-09-29T16:00:00Z", end: "2026-09-29T17:30:00Z" }]));
check("the reader never calls a calendar directly: only through the calendar grant", !/fetchBusy|calendar\/v3\/freeBusy/.test(data) && /calendarBusy\(userId/.test(data));
// ------------------------------------------------ what Cue is told
const facts = D.describeSnapshot({ busy: busy!, fetchedAt: now }, "America/Los_Angeles", now);
check("busy times read in their own zone, with no event details", /busy Tue Sep 29 9:00 AM–10:30 AM/.test(facts[0]) && /never what the events are/.test(facts[0]) && facts.length === 1);
check("an empty calendar says so plainly", /free for the next 4 days/.test(D.describeSnapshot({ busy: [], fetchedAt: now }, null, now)[0]));
check("nothing is fetched while they wait: the context reads the cache, refreshes in the background", /refreshGoogleSnapshot\(userId\)\s*\.catch/.test(data) && !/await refreshGoogleSnapshot/.test(data.split("export async function googleFactsFor")[1] ?? ""));
check("the context only loads Google for members who connected their calendar, and only their own", /calendarConnected\(userId\)/.test(src("services/turnContext.ts")) && /EXISTS \(SELECT 1 FROM calendar_grants WHERE user_id = \$1\)/.test(data));

// ------------------------------------------------ Cue's tools and pages
const { capabilitySheet, ABILITIES } = await import("../../src/services/capabilities.js");
check("Cue never offers Gmail: no ability, no sheet line", !ABILITIES.some((a) => a.id === "google" || a.tool === "googleConnection") && !capabilitySheet({ team: true }).some((l) => /connect Gmail|connected Gmail|connect their Gmail/i.test(l)));
const route = src("routes/google.ts");
check("the pages never show anyone's data and are mounted at /google", !/busy|waiting|snapshot|SELECT/.test(route.replace(/export const CALENDAR_GRANT_COPY = \{[\s\S]*?\} as const;/, "")) && /app\.use\("\/google", createGoogleRouter\(\)\)/.test(src("server.ts")));
check("an expired, reused or old combined-grant link says so and asks for a new one", /status\(410\)/.test(route) && !/consentUrlFor/.test(route));

console.log(`google rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
