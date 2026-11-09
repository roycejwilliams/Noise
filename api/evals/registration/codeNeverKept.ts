// "Cue won't save the code": proven on the real inbound handler (routes/sendblue.ts /webhook), not just the copy. A member with an active
// code challenge texts a code (a random 6-digit string made fresh each run, never a real Luma code); everything the handler and the
// registration path write, log, send, embed or fetch is captured, and the code must appear in none of it. The held page is a fake whose
// code entry fails with the code in its error (the worst case for a careless log line), so the member still gets their line back.
// Layer 1: a fake database, a fake Sendblue, a fake embeddings client; no browser, no network, zero tokens.
//   npx tsx evals/registration/codeNeverKept.ts
import fs from "node:fs";
import { randomInt } from "node:crypto";
import pg from "pg";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.error(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 900)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const CODE = String(randomInt(100000, 1000000));
const PHONE = "+14155550142";
const U = "00000000-0000-4000-8000-0000000c0de1";
const REG = "00000000-0000-4000-8000-0000000c0de2";

// ---- captures
const logged: string[] = [];
const origLog = { log: console.log, error: console.error, warn: console.warn, info: console.info };
for (const k of ["log", "error", "warn", "info"] as const) (console as any)[k] = (...a: unknown[]) => void logged.push(a.map((x) => (typeof x === "string" ? x : x instanceof Error ? `${x.message}\n${x.stack}` : JSON.stringify(x))).join(" "));
const restore = () => Object.assign(console, origLog);
const writes: { sql: string; params: unknown[] }[] = [];
const fetched: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => { fetched.push(`${String(input?.url ?? input)} ${String(init?.body ?? "")}`); return realFetch(input, init); }) as typeof fetch;

// ---- a fake database: the challenge, the registration waiting on a code, and everything else answered empty
const row: any = {
  id: REG, user_id: U, event_key: "luma:demo-night", event_url: "https://luma.com/demo-night", item_key: null, event_name: "Demo Night", status: "needs_member_code",
  form: { url: "https://luma.com/demo-night", eventName: "Demo Night", when: "Fri Nov 20, 6:00 PM", action: "register", tickets: [], priceText: "Free", fields: [], gate: "login", signIn: "email_code", readAt: "x" },
  scope: null, scope_hash: "h", answers: {}, drafts: [], asked_at: new Date(), ask_kind: "submit", ask_text: "Want me to register you for this event using these details?", attempts: 1,
  submit_started_at: new Date(), outcome: { state: "uncertain", link: "https://luma.com/demo-night", linkKind: "event_page", detail: "sign_in", at: "x" }, updated_at: new Date(),
};
const answer = async (sql: string, params: unknown[] = []) => {
  writes.push({ sql: String(sql), params });
  if (/FROM event_registrations r JOIN users u/.test(sql)) return { rows: [{ id: REG, user_id: U }], rowCount: 1 };
  if (/SELECT \* FROM event_registrations WHERE user_id = \$1 AND id = \$2/.test(sql)) return { rows: [{ ...row }], rowCount: 1 };
  if (/UPDATE event_registrations SET status = \$3/.test(sql)) { row.status = params[2]; return { rows: [{ ...row }], rowCount: 1 }; }
  if (/INSERT INTO inbound_webhook_handles \(handle\) VALUES/.test(sql)) return { rows: [{ handle: params[0] }], rowCount: 1 };
  if (/SELECT first_name, last_name, email, phone_number FROM users/.test(sql)) return { rows: [{ first_name: "Jordan", last_name: "Ellis", email: "jordan@example.com", phone_number: PHONE }], rowCount: 1 };
  if (/INSERT INTO co_memories/.test(sql)) return { rows: [{ id: "m1" }], rowCount: 1 };
  if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: true }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};
const pool = (await import("../../src/db/db.js")).default as any;
pool.query = answer;
pool.connect = async () => ({ query: answer, release: () => {} });
// The phone lock's own pool (db/advisoryLock.ts): every pg Pool answers from the same fake.
(pg.Pool.prototype as any).connect = async () => ({ query: answer, release: () => {} });

// ---- fakes for what leaves the process
(await import("../../src/services/embeddings.js")).setEmbeddingsClientForTests({ embeddings: { create: async ({ input }: any) => { writes.push({ sql: "EMBED", params: [input] }); return { data: (Array.isArray(input) ? input : [input]).map((_: unknown, index: number) => ({ embedding: new Array(1536).fill(0), index })) } as any; } } } as any);
const SB = (await import("../../src/services/sendblue.js")).default as any;
const sent: any[] = [];
SB.messages.send = async (body: any) => { sent.push(body); return { message_handle: "out-1", status: "QUEUED" }; };
(await import("../../src/services/eventRegistration/approvals.js")).setRegistrationLiveForTests(true);

// ---- the held page waiting on their code: its code entry fails, with the code in its own error message
const D = await import("../../src/services/eventRegistration/lumaDriver.js");
let closed = 0;
const fakeSession: any = {
  enterCode: async (code: string) => { throw new Error(`Target page, context or browser has been closed while typing ${code}`); },
  close: async () => { closed++; },
  read: async () => { throw new Error("unused"); }, startSignIn: async () => ({ ok: false, detail: "unused" }), fill: async () => ({ ok: false, detail: "unused" }),
  submit: async () => { throw new Error("unused"); }, readResult: async () => ({ state: "unknown", detail: null, link: null, linkKind: "event_page" }), pageText: async () => "", ownState: async () => ({ state: "unknown", why: "" }),
};
D.holdSession(REG, fakeSession);

// ---- the real inbound handler, one text: the code
const S = await import("../../src/routes/sendblue.js");
const router: any = S.sendblueRouter({ to: () => ({ emit: () => {} }) } as any);
const post = router.stack.find((l: any) => l.route?.path === "/webhook").route.stack[0].handle;
const acks: number[] = [];
const res: any = { status: (c: number) => (acks.push(c), res), send: () => res, json: () => res, sendStatus: () => res, headersSent: false };
const body = { number: PHONE, content: `it's ${CODE}`, message_handle: "code-msg-1", is_outbound: false, message_type: "message", sendblue_number: "+14155550100", date_sent: new Date().toISOString() };
await post({ body, get: () => undefined, ip: "test" }, res, () => {});
for (let i = 0; i < 80 && !sent.length; i++) await new Promise((r) => setTimeout(r, 25));
restore();
globalThis.fetch = realFetch;

const has = (x: unknown) => JSON.stringify(x ?? null).includes(CODE);
check("Sendblue got its 200 at once", acks[0] === 200);
check("the member got their line back (the held page broke: the signup starts over, with the existing timeout line)", sent.length === 1 && /^The signup page timed out while I waited for the code, so nothing was submitted\./.test(String(sent[0]?.content ?? "")), sent);
check("the registration expired by its stage (before a submit: back to the start), and the page was released", row.status === "inspected" && closed >= 1, { status: row.status, closed });
check("the stored delivery (inbound_webhook_handles.payload) never had the code", writes.filter((w) => /inbound_webhook_handles/.test(w.sql)).every((w) => !has(w.params)) && writes.some((w) => /SET payload = \$2::jsonb/.test(w.sql)));
check("their line in the thread is the placeholder, never the code", writes.some((w) => /INSERT INTO co_memories/.test(w.sql) && has === has && JSON.stringify(w.params).includes("[a sign-in code for an event signup, used once and not kept]")) && writes.filter((w) => /co_memories/.test(w.sql)).every((w) => !has(w.params)));
check("no database write or read anywhere carries the code (registrations, corrections, decision rows, outbound record, ledger)", writes.every((w) => !w.sql.includes(CODE) && !has(w.params)), writes.filter((w) => has(w.params) || w.sql.includes(CODE)).map((w) => w.sql.slice(0, 80)));
check("no embedding was asked for the code", writes.filter((w) => w.sql === "EMBED").every((w) => !has(w.params)));
check("no log line carries the code (stdout and stderr are Railway's logs), not even the page error that had it", logged.every((l) => !l.includes(CODE)), logged.filter((l) => l.includes(CODE)));
check("nothing sent to Sendblue carries the code", sent.every((b) => !has(b)));
check("no outside call was made (no model, no trace, no Langfuse) on this path", fetched.length === 0, fetched);
check("the held page was taken out of memory (nothing still holds it)", !D.isHeld(REG));

// ---- the rest of the code's path, by reading the code itself
const driver = src("services/eventRegistration/lumaDriver.ts");
check("Playwright: no tracing, HAR, video or screenshot in the registration driver", !/tracing\.start|recordHar|recordVideo|\.screenshot\(/.test(driver));
check("the driver never logs: no console call anywhere in it", !/console\./.test(driver));
const tools = src("agent/registrationTools.ts");
check("a failed code entry is caught without logging its error", /async function useCode\([\s\S]{0,300}catch \{[\s\S]{0,200}Never the error's text/.test(tools));
check("the code is never a tool input, never in a model prompt (no tool takes it; the guard's log keeps ids only)", !/code:\s*z\./.test(tools) && /registrationReceipt/.test(src("agent/toolGuard.ts")));
const route = src("routes/sendblue.ts");
check("the route's catch logs only the error's message, and the code path never throws one (continueWithCode never throws)", /registration code: handling failed \(non-fatal\):", err\?\.message/.test(route) && /Never throws and always has a line to send/.test(tools));
check("no body logging middleware in either server", !/morgan|console\.(?:log|error)\(req\.body/.test(src("server.ts")) && !/morgan|console\.(?:log|error)\(req\.body/.test(fs.readFileSync(new URL("../../../co-test/src/server.ts", import.meta.url), "utf8")));

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
