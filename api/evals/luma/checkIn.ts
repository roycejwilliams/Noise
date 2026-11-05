// A guest checked in at the door of one of Noise's own Luma events (2026-11-04): they count as arrived at once (which starts the in-room
// matching), a second delivery changes nothing, and the morning after they get the debrief. Other hosts' events never send a webhook.
// The payload's exact fields have never been seen, so the first delivery of each type logs names and kinds (never values).
// Layer 1: the real handler, markArrived and the debrief draft on a fake store and a fake model. Zero tokens, no DB, nothing sent.
//   npx tsx evals/luma/checkIn.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const L = await import("../../src/services/lumaCheckIn.js");
const CF = await import("../../src/services/eventCheckinFollowUp.js");
const P = await import("../../src/harness/proactive.js");
const { proactiveRegistry: registry } = await import("../../src/harness/proactiveRegistry.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const u = "00000000-0000-4000-8000-0000000000d1";
const u2 = "00000000-0000-4000-8000-0000000000d2";
const ev = "evt-noise-1104";
const world = { handles: new Set<string>(), arrivals: [] as { ev: string; user: string; via: string }[], arrived: false };
(pool as any).query = async (sql: string, p: any[] = []) => {
  if (/INSERT INTO inbound_webhook_handles/.test(sql)) { if (world.handles.has(p[0])) return { rows: [] }; world.handles.add(p[0]); return { rows: [{ handle: p[0] }] }; }
  if (/DELETE FROM inbound_webhook_handles/.test(sql)) { world.handles.delete(p[0]); return { rows: [] }; }
  if (/FROM users WHERE archived_at IS NULL AND LOWER\(email\)/.test(sql)) return { rows: p[0] === "jordan@example.com" ? [{ id: u }] : p[0] === "other@example.com" ? [{ id: u2 }] : [] };
  if (/FROM users WHERE archived_at IS NULL AND phone_number/.test(sql)) return { rows: p[0] === "+14155550101" ? [{ id: u }] : p[0] === "+14155550102" ? [{ id: u2 }] : [] };
  if (/INSERT INTO event_presence \(event_api_id, user_id, arrived_at, arrived_via\)/.test(sql)) {
    if (world.arrivals.some((a) => a.ev === p[0] && a.user === p[1])) return { rows: [] };
    world.arrivals.push({ ev: p[0], user: p[1], via: p[2] }); world.arrived = true;
    return { rows: [{ user_id: p[1], is_new: true }] };
  }
  if (/INSERT INTO harness_decisions|harness_decisions/.test(sql)) return { rows: [] };
  if (/arrived_at IS NOT NULL/.test(sql)) return { rows: world.arrived ? [{ x: 1 }] : [] };
  if (/SELECT email, phone_number FROM users/.test(sql)) return { rows: [{ email: "jordan@example.com", phone_number: "+14155550101" }] };
  if (/FROM users u LEFT JOIN event_presence/.test(sql)) return { rows: [{ email: "jordan@example.com", phone_number: "+14155550101", not_going_at: null, noshow_asked_at: null }] };
  return { rows: [] };
};
let rescored: string[] = [];
let listed = true;
const deps = { ours: async (id: string) => id === ev, rescore: (id: string) => { rescored.push(id); }, onGuestList: async () => listed };
const guest = (over: any = {}) => ({ id: "gst-1", event_api_id: ev, user_email: "Jordan@Example.com", checked_in_at: "2026-11-04T01:05:00.000Z", approval_status: "approved", ...over });

// 1. what the payload says, whatever its shape
{
  const a = L.readGuestWebhook(guest());
  check("read: a flat guest payload", a.checkedIn && a.eventId === ev && a.email === "jordan@example.com" && a.guestKey === "gst-1", a);
  const b = L.readGuestWebhook({ guest: { id: "g9", email: "Jo@Example.com", checked_in_at: "2026-11-04T01:05:00Z" }, event_api_id: ev });
  check("read: a guest nested under 'guest'", b.checkedIn && b.email === "jo@example.com" && b.eventId === ev, b);
  check("read: no check-in time is not a check-in", !L.readGuestWebhook(guest({ checked_in_at: null })).checkedIn && !L.readGuestWebhook(guest({ checked_in_at: "" })).checkedIn);
}

// 2. the first delivery logs the type and field names, once, and never a value
{
  const logs: string[] = [];
  const realLog = console.log; console.log = (...a: any[]) => { logs.push(a.join(" ")); };
  const payload = { type: "guest.updated", data: guest() };
  await L.logFirstDelivery("guest.updated", payload);
  await L.logFirstDelivery("guest.updated", payload);
  console.log = realLog;
  check("first delivery: logged once, with the type", logs.length === 1 && /first "guest\.updated" delivery/.test(logs[0]), logs);
  check("first delivery: field names and kinds, including checked_in_at, never values", /checked_in_at:string/.test(logs[0]) && !/jordan@example\.com/i.test(logs[0]) && !/2026-11-04T01/.test(logs[0]), logs[0]);
}

// 3. a check-in: arrived now, once; a duplicate changes nothing
{
  const r1 = await L.handleGuestCheckIn(guest(), "Noise Dinner", deps);
  check("check-in: the member counts as arrived at once, through the door", r1 === "arrived" && world.arrivals.length === 1 && world.arrivals[0].via === "door" && world.arrivals[0].ev === ev, { r1, arrivals: world.arrivals });
  check("check-in: the in-room matching starts (the arrival re-score)", rescored.length === 1 && rescored[0] === ev, rescored);
  const r2 = await L.handleGuestCheckIn(guest(), "Noise Dinner", deps);
  const r3 = await L.handleGuestCheckIn(guest({ checked_in_at: "2026-11-04T01:06:00.000Z" }), "Noise Dinner", deps);
  check("duplicate webhook: one arrival, one re-score", r2 === "duplicate" && r3 === "duplicate" && world.arrivals.length === 1 && rescored.length === 1, { r2, r3, arrivals: world.arrivals.length, rescored: rescored.length });
}
// 3b. what is not an arrival
{
  world.handles.clear(); world.arrivals.length = 0; rescored = [];
  check("an edit with no check-in: nothing", (await L.handleGuestCheckIn(guest({ checked_in_at: null }), undefined, deps)) === "not_a_checkin" && !world.arrivals.length);
  check("another host's event: nothing (we'd never be sent it, and it isn't ours)", (await L.handleGuestCheckIn(guest({ event_api_id: "evt-someone-else" }), undefined, deps)) === "not_ours" && !world.arrivals.length);
  check("a guest who isn't a member: nothing", (await L.handleGuestCheckIn(guest({ user_email: "stranger@example.com", id: "gst-2" }), undefined, deps)) === "not_a_member" && !world.arrivals.length && !rescored.length);
  check("no event id: nothing", (await L.handleGuestCheckIn(guest({ event_api_id: undefined }), undefined, deps)) === "no_event");
  // a failure releases the claim; the route acks first, so only a later edit of the guest tries again
  const failing = { ...deps, arrive: async () => { throw new Error("db down"); } };
  let threw = false; try { await L.handleGuestCheckIn(guest({ id: "gst-3" }), undefined, failing); } catch { threw = true; }
  check("a failed arrival releases the claim so a retry is processed", threw && (await L.handleGuestCheckIn(guest({ id: "gst-3" }), undefined, deps)) === "arrived");
}

// 3c. who the guest is: email first, phone only without an email; a split identity is refused; the member must be on the list
{
  world.handles.clear(); world.arrivals.length = 0; rescored = [];
  const errs: string[] = [];
  const realErr = console.error; console.error = (...a: any[]) => { errs.push(a.join(" ")); };
  const split = await L.handleGuestCheckIn(guest({ id: "gst-4", user_email: "jordan@example.com", phone_number: "+14155550102" }), undefined, deps);
  console.error = realErr;
  check("a guest whose email and phone are different members is refused, nobody arrives", split === "identity_conflict" && !world.arrivals.length && !rescored.length, { split });
  check("the refusal is logged without the email, phone or ids", errs.length === 1 && !/jordan|example\.com|\+1415|0000d/i.test(errs[0]), errs);
  const emailWins = await L.handleGuestCheckIn(guest({ id: "gst-5", user_email: "jordan@example.com", phone_number: "+14155550199" }), undefined, deps);
  check("email first: a phone that matches nobody doesn't block the email's member", emailWins === "arrived" && world.arrivals[0]?.user === u, { emailWins, a: world.arrivals });
  world.arrivals.length = 0;
  const phoneOnly = await L.handleGuestCheckIn(guest({ id: "gst-6", user_email: undefined, phone_number: "+14155550102" }), undefined, deps);
  check("phone is used only when the guest has no email", phoneOnly === "arrived" && world.arrivals[0]?.user === u2, { phoneOnly, a: world.arrivals });
  world.arrivals.length = 0;
  const phoneNotUsed = await L.handleGuestCheckIn(guest({ id: "gst-7", user_email: "stranger@example.com", phone_number: "+14155550101" }), undefined, deps);
  check("an email that matches nobody is not rescued by the phone", phoneNotUsed === "not_a_member" && !world.arrivals.length, { phoneNotUsed });
  listed = false;
  const off = await L.handleGuestCheckIn(guest({ id: "gst-8" }), undefined, deps);
  check("a member not on the event's guest list is refused, nobody arrives", off === "not_on_guest_list" && !world.arrivals.length, { off });
  listed = true;
  check("...and the claim is released, so a later edit once they're listed is processed", (await L.handleGuestCheckIn(guest({ id: "gst-8" }), undefined, deps)) === "arrived");
  world.arrivals.length = 0; world.handles.clear(); world.arrived = false; rescored = [];
}

// 4. after the event: checked in -> the debrief ("how was it"), through the real draft
{
  world.arrivals.length = 0; world.handles.clear(); world.arrived = false;
  let prompts: string[] = [];
  P.setProactiveModelForTests(async (prompt: string) => { prompts.push(prompt); return /Ask how "/.test(prompt) ? "How was Noise Dinner? Who did you meet?" : /whether they ended up making it/.test(prompt) ? "Did you end up going to Noise Dinner?" : "SKIP"; });
  // The member's day, not the UTC date: between 00:00 UTC and LA midnight a UTC "yesterday" is still today for them (the fallback zone).
  const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(Date.now() - 86_400_000));
  const cand = { id: "c1", userId: u, type: "debrief", targetKey: `debrief:${ev}`, topicKey: null, summary: "", priority: 50, attempts: 0, dueAt: new Date(), expiresAt: new Date(Date.now() + 72 * 3_600_000), createdAt: new Date(), payload: { eventApiId: ev, eventName: "Noise Dinner", eventDate: yesterday, outcomeFollowupIds: [], checkinFollowupIds: ["chk-1"], walkinCheckinIds: [], askText: null } } as any;
  const person = { userId: u, firstName: "Jordan", phoneNumber: "+14155550101" } as any;
  const door = [{ api_id: "g2", email: "other@example.com", phone: null, name: "O", approval_status: "approved", registered_at: null, checked_in_at: "2026-11-04T01:00:00Z" } as any];
  CF.setDoorDepsForTests({ ours: async () => true, guestList: async () => door });
  const before: any = await registry.debrief.draft(cand, person);
  check("registered, door tracked, no check-in (nor arrival) of theirs: the no-show flow's, not a debrief", "skip" in before && /no-show flow/.test(before.skip) && prompts.length === 0, before);
  await L.handleGuestCheckIn(guest(), "Noise Dinner", deps);
  const after: any = await registry.debrief.draft(cand, person);
  check("checked in at the door: the morning-after debrief ('how was it')", after.text === "How was Noise Dinner? Who did you meet?" && /Ask how "Noise Dinner" was/.test(prompts[0] ?? ""), { after, p: (prompts[0] ?? "").slice(-300) });
}

// 4b. signed check-ins only, and "test-" ids are never ours outside stubs
{
  const { createHmac } = await import("node:crypto");
  const { lumaWebhookStanding } = await import("../../src/routes/luma.js");
  const body = JSON.stringify({ type: "guest.updated", data: guest() });
  const t = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex");
  const std = (o: any) => lumaWebhookStanding({ rawBody: body, ...o });
  check("signed with the secret: signed", std({ secret: "whsec_test", header: `t=${t},v1=${sig}` }) === "signed");
  check("a wrong signature is rejected", std({ secret: "whsec_test", header: `t=${t},v1=${sig.replace(/.$/, sig.endsWith("0") ? "1" : "0")}` }) === "rejected");
  check("no signature header with a secret set is rejected", std({ secret: "whsec_test", header: undefined }) === "rejected");
  check("a stale timestamp is rejected", std({ secret: "whsec_test", header: `t=${Number(t) - 3600},v1=${createHmac("sha256", "whsec_test").update(`${Number(t) - 3600}.${body}`).digest("hex")}` }) === "rejected");
  check("no secret: never 'signed' (dev still passes other types, production rejects)", std({ secret: undefined, header: `t=${t},v1=${sig}`, nodeEnv: "development" }) === "unsigned_dev" && std({ secret: undefined, header: undefined, nodeEnv: "production" }) === "rejected");
  const route = src("routes/luma.ts");
  check("the route handles a check-in only when the delivery is signed", /type === "guest\.updated" && standing !== "signed"/.test(route) && /else if \(type === "guest\.updated"\) \{\s*handleGuestCheckIn/.test(route));
  check("the retry comment says the route acks first", /acks 200 before any handling, so Luma never retries|The 200 goes out before any handling, so Luma never retries/.test(route) && !/Luma's retry/.test(src("services/lumaCheckIn.ts")));
  world.handles.clear(); world.arrivals.length = 0;
  const viaTest = await L.handleGuestCheckIn(guest({ event_api_id: "test-evt-1" }), undefined, { rescore: () => {}, onGuestList: async () => true, knownEvents: async () => [{ api_id: ev }] });
  check("a 'test-' event id is not ours by default", viaTest === "not_ours" && !world.arrivals.length, viaTest);
  const stub = await L.handleGuestCheckIn(guest({ event_api_id: "test-evt-1", id: "gst-t" }), undefined, { rescore: () => {}, onGuestList: async () => true, allowTestEvents: true, knownEvents: async () => [] });
  check("...only a layer-1 stub that opts in", stub === "arrived", stub);
  world.handles.clear(); world.arrivals.length = 0; world.arrived = false;
}

// 5. wiring
{
  const route = src("routes/luma.ts");
  check("the route hands guest.updated to the check-in handler and logs each type's first delivery", /handleGuestCheckIn\(\{ \.\.\.data, event_api_id: eventId \}/.test(route) && /logFirstDelivery\(String\(type\), payload\)/.test(route) && /type === "guest\.updated"/.test(route));
  check("arrived_via accepts 'door' in code and in the migration", /via: "location" \| "text" \| "door"/.test(src("services/eventPresence.ts")) && /IN \('location', 'text', 'door'\)/.test(src("db/migrations.ts")));
  const M = await import("../../src/db/migrations.js");
  const ran: string[] = [];
  const fakeDb = (def: string | null, failOn?: RegExp) => ({ query: async (sql: string) => { ran.push(sql); if (failOn?.test(sql)) throw new Error("boom"); return { rows: def ? [{ def }] : [] }; } });
  check("migration: a no-op (one read, no ALTER, no lock) when 'door' is already allowed", (await M.ensureDoorArrivals(fakeDb("CHECK ((arrived_via = ANY (ARRAY['location'::text, 'text'::text, 'door'::text])))"))) === "noop" && ran.length === 1 && !/ALTER|DO \$\$/.test(ran[0]), ran);
  ran.length = 0;
  check("migration: changes the constraint when 'door' is missing", (await M.ensureDoorArrivals(fakeDb("CHECK ((arrived_via = ANY (ARRAY['location'::text, 'text'::text])))"))) === "changed" && ran.length === 2 && /ADD CONSTRAINT/.test(ran[1]), ran);
  const realErr = console.error; console.error = () => {};
  const failed = await M.ensureDoorArrivals(fakeDb(null, /DO \$\$/));
  console.error = realErr;
  check("migration: a failure is caught inside (never throws into the rest of the chain)", failed === "failed");
  const mig = src("db/migrations.ts");
  check("migration: the chain calls it as its own step", /\.then\(\(\) => ensureDoorArrivals\(\)\)/.test(mig));
  check("dedupe goes through inbound_webhook_handles", /INSERT INTO inbound_webhook_handles/.test(src("services/lumaCheckIn.ts")));
}

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
