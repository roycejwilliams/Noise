// Model-free checks for Google Calendar and Gmail (services/googleAuth.ts,
// googleData.ts, googleTools.ts, routes/google.ts): read-only scopes,
// encryption, one-time state, owner scoping, revoke on disconnect, and what
// Co gets to see. Google responses are mocked; no credentials needed.
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

// ------------------------------------------------ scopes: read-only, minimal
check("only two scopes: calendar free/busy and Gmail metadata", JSON.stringify(A.GOOGLE_SCOPES) === JSON.stringify(["https://www.googleapis.com/auth/calendar.freebusy", "https://www.googleapis.com/auth/gmail.metadata"]));
check("no send, compose, modify, insert or full-access scope anywhere", !/gmail\.(send|compose|modify|insert|readonly)|mail\.google\.com|auth\/calendar(\.events)?["'\s]|calendar\.events|auth\/drive/.test(auth + data));
check("granted scopes must be a subset of what Co asked for", A.scopesAllowed("https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/gmail.metadata") && A.scopesAllowed("https://www.googleapis.com/auth/calendar.freebusy"));
check("anything wider is refused", !A.scopesAllowed("https://www.googleapis.com/auth/gmail.metadata https://www.googleapis.com/auth/gmail.send") && !A.scopesAllowed("") && !A.scopesAllowed("https://mail.google.com/"));
check("wider scopes are revoked, not kept", /if \(!scopesAllowed\(tokens\.scope \?\? ""\)\) \{\s*\/\/[^\n]*\n\s*await revokeToken\(/.test(auth));

// ------------------------------------------------ the consent URL
const env = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec", GOOGLE_TOKEN_KEY: randomBytes(32).toString("base64"), API_URL: "https://test.copatible.com" } as any;
const u = new URL(A.authUrl("STATE123", "CHAL", env));
check("consent URL asks for exactly those scopes, offline, with state and PKCE S256", u.searchParams.get("scope") === A.GOOGLE_SCOPES.join(" ") && u.searchParams.get("access_type") === "offline" && u.searchParams.get("state") === "STATE123" && u.searchParams.get("code_challenge") === "CHAL" && u.searchParams.get("code_challenge_method") === "S256" && u.searchParams.get("include_granted_scopes") === "false");
check("the redirect goes back to co-test", u.searchParams.get("redirect_uri") === "https://test.copatible.com/google/callback" && A.redirectUri(env) === "https://test.copatible.com/google/callback");
check("off until every setting exists", A.googleConfigured(env) && !A.googleConfigured({ ...env, GOOGLE_CLIENT_SECRET: "" }) && !A.googleConfigured({ ...env, GOOGLE_TOKEN_KEY: "short" }) && !A.googleConfigured({ ...env, API_URL: "http://insecure.example" }));
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
check("tokens are only ever stored encrypted", !/INSERT INTO google_connections[\s\S]{0,400}tokens\.(access|refresh)_token[,)]/.test(auth) && /encryptToken\(tokens\.access_token\)/.test(auth) && /encryptToken\(verifier\)/.test(auth));

// ------------------------------------------------ one-time state, owner scoping, disconnect
check("a connect link is single use and expires", /UPDATE google_oauth_states SET used_at = NOW\(\) WHERE state = \$1 AND used_at IS NULL AND expires_at > NOW\(\)/.test(auth) && /WHERE state = \$1 AND used_at IS NULL AND expires_at > NOW\(\)/.test(auth) && A.LINK_TTL_MS === 15 * 60 * 1000);
check("the state is random and long", /randomBytes\(24\)\.toString\("base64url"\)/.test(auth));
const userQueries = (auth + data).match(/(FROM|INTO|UPDATE|DELETE FROM) google_(connections|snapshots)[\s\S]{0,300}?\[/g) ?? [];
check("every token and snapshot query is for one member", userQueries.length >= 6 && userQueries.every((q) => /user_id = \$1|VALUES \(\$1/.test(q)));
check("disconnect deletes, revokes with Google, and clears the cached summary", /DELETE FROM google_connections WHERE user_id = \$1 RETURNING/.test(auth) && /DELETE FROM google_snapshots WHERE user_id = \$1/.test(auth) && /if \(token\) await revokeToken\(token, fetchImpl\)/.test(auth) && /oauth2\.googleapis\.com\/revoke/.test(auth));
check("a token revoked on Google's side is forgotten here", /t\.error === "invalid_grant"\) await pool\.query\(`DELETE FROM google_connections WHERE user_id = \$1`/.test(auth));
check("reads are logged as decisions", /decision: "google\.read"/.test(data) && /decision: "google\.connect"/.test(auth) && /decision: "google\.disconnect"/.test(auth));

// ------------------------------------------------ reading (mocked Google)
const now = new Date("2026-09-28T19:00:00Z");
const json = (body: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);
const fbFetch = ((url: string, init: any) => {
  const body = JSON.parse(init.body);
  return json({ calendars: { primary: { busy: [{ start: "2026-09-29T16:00:00Z", end: "2026-09-29T17:30:00Z" }] } }, _asked: body });
}) as any;
const busy = await D.fetchBusy("tok", now, fbFetch);
check("free/busy is read for the primary calendar", JSON.stringify(busy) === JSON.stringify([{ start: "2026-09-29T16:00:00Z", end: "2026-09-29T17:30:00Z" }]));
const day = 86_400_000;
const gmailFetch = ((url: string) => {
  if (url.includes("/messages?labelIds=SENT")) return json({ messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }, { id: "m3", threadId: "t3" }] });
  const h = (n: string, v: string) => ({ name: n, value: v });
  if (url.includes("/threads/t1")) return json({ messages: [{ labelIds: ["SENT"], internalDate: String(now.getTime() - 3 * day), payload: { headers: [h("Subject", "Sponsorship for Oct 10"), h("To", '"Jordan Lee" <jordan@acme.com>')] } }] });
  if (url.includes("/threads/t2")) return json({ messages: [{ labelIds: ["SENT"], internalDate: String(now.getTime() - 3 * day), payload: { headers: [h("Subject", "Venue")] } }, { labelIds: ["INBOX"], internalDate: String(now.getTime() - 2 * day), payload: { headers: [] } }] });
  if (url.includes("/threads/t3")) return json({ messages: [{ labelIds: ["SENT"], internalDate: String(now.getTime() - 2 * 3_600_000), payload: { headers: [h("Subject", "Just now"), h("To", "ellis@x.org")] } }] });
  return json({}, false);
}) as any;
const waiting = await D.fetchWaiting("tok", now, gmailFetch);
check("an email they sent with no reply for over a day is waiting", waiting?.length === 1 && waiting[0].subject === "Sponsorship for Oct 10" && waiting[0].to === "Jordan Lee (acme.com)");
check("a replied thread and one sent hours ago aren't", !waiting?.some((w) => /Venue|Just now/.test(w.subject)));
check("Gmail is asked for metadata only, never message bodies", /format=metadata/.test(data) && !/format=(full|raw)/.test(data) && !/\/messages\/[^?]*\?(?!.*format=metadata)/.test(data.replace(/messages\?labelIds=SENT/, "")));
check("recipients show a name and domain, not a full address", D.recipientLabel('"Noor K" <noor@studio.co>, other@x.com') === "Noor K (studio.co)" && D.recipientLabel("ellis@x.org") === "x.org");

// ------------------------------------------------ what Co is told
const facts = D.describeSnapshot({ busy: busy!, waiting: waiting!, fetchedAt: now }, "America/Los_Angeles", now);
check("busy times read in their own zone, with no event details", /busy Tue Sep 29 9:00 AM–10:30 AM/.test(facts[0]) && /never what the events are/.test(facts[0]));
check("waiting emails read as who, subject and date, never the message", /"Sponsorship for Oct 10" to Jordan Lee \(acme\.com\), sent Fri Sep 25/.test(facts[1]) && /never the message/.test(facts[1]));
check("an empty calendar and inbox say so plainly", /free for the next 4 days/.test(D.describeSnapshot({ busy: [], waiting: [], fetchedAt: now }, null, now)[0]) && /None of their recent sent emails is waiting/.test(D.describeSnapshot({ busy: [], waiting: [], fetchedAt: now }, null, now)[1]));
check("nothing is fetched while they wait: the context reads the cache, refreshes in the background", /refreshGoogleSnapshot\(userId\)\s*\.catch/.test(data) && !/await refreshGoogleSnapshot/.test(data.split("export async function googleFactsFor")[1] ?? ""));
check("the context only loads Google for members who connected it, and only their own", /if \(!\(await isConnected\(userId\)\)\.connected\) return \[\];/.test(src("services/turnContext.ts")) && /WHERE c\.user_id = \$1/.test(data));

// ------------------------------------------------ Co's tool and pages
const tools = src("services/googleTools.ts");
const conv = src("agent/conversationTools.ts");
check("the tool goes through the same guard as every other tool", /Object\.assign\(tools, googleTools\(ctx, notDone\)\);\s*\n\s*\/\/[^\n]*\n\s*guardTools\(tools/.test(conv));
check("the link goes only to this member, as its own text", /ctx\.sendCoReply\(\{ phone: ctx\.phoneNumber, message: link, asVoice: false \}\)/.test(tools) && /createConnectLink\(ctx\.userId\)/.test(tools));
check("without Google set up, Co says so instead of sending anything", /if \(!googleConfigured\(\)\) \{\s*notDone\(/.test(tools));
const { capabilitySheet } = await import("../../src/services/capabilities.js");
const saved = { id: process.env.GOOGLE_CLIENT_ID, sec: process.env.GOOGLE_CLIENT_SECRET, key: process.env.GOOGLE_TOKEN_KEY };
delete process.env.GOOGLE_CLIENT_ID;
check("Co says it can't connect Google until it's set up", capabilitySheet().some((l) => l === "Co can't connect to their Google Calendar or Gmail yet."));
Object.assign(process.env, { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec", GOOGLE_TOKEN_KEY: env.GOOGLE_TOKEN_KEY });
check("once set up, Co says exactly what it sees and that it never sends or edits", capabilitySheet().some((l) => /busy or free only, never what the events are/.test(l) && /never sends email, never changes their calendar/.test(l) && /disconnect Google/.test(l)));
for (const [k, v] of [["GOOGLE_CLIENT_ID", saved.id], ["GOOGLE_CLIENT_SECRET", saved.sec], ["GOOGLE_TOKEN_KEY", saved.key]] as const) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
const route = src("routes/google.ts");
check("the pages never show anyone's data and are mounted at /google", !/busy|waiting|snapshot|SELECT/.test(route.replace(/Co can now see when you're busy[^"]*/, "")) && /app\.use\("\/google", createGoogleRouter\(\)\)/.test(src("server.ts")));
check("an expired or reused link says so and asks for a new one", /if \(!url\) return res\.status\(410\)/.test(route));

console.log(`google rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
