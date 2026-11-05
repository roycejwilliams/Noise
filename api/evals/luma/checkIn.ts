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
const ev = "evt-noise-1104";
const world = { handles: new Set<string>(), arrivals: [] as { ev: string; user: string; via: string }[], arrived: false };
(pool as any).query = async (sql: string, p: any[] = []) => {
  if (/INSERT INTO inbound_webhook_handles/.test(sql)) { if (world.handles.has(p[0])) return { rows: [] }; world.handles.add(p[0]); return { rows: [{ handle: p[0] }] }; }
  if (/DELETE FROM inbound_webhook_handles/.test(sql)) { world.handles.delete(p[0]); return { rows: [] }; }
  if (/FROM users WHERE archived_at IS NULL/.test(sql)) return { rows: p[0] === "jordan@example.com" ? [{ id: u }] : [] };
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
const deps = { ours: async (id: string) => id === ev, rescore: (id: string) => { rescored.push(id); } };
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
  // a failure lets Luma's retry try again
  const failing = { ...deps, arrive: async () => { throw new Error("db down"); } };
  let threw = false; try { await L.handleGuestCheckIn(guest({ id: "gst-3" }), undefined, failing); } catch { threw = true; }
  check("a failed arrival releases the claim so a retry is processed", threw && (await L.handleGuestCheckIn(guest({ id: "gst-3" }), undefined, deps)) === "arrived");
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

// 5. wiring
{
  const route = src("routes/luma.ts");
  check("the route hands guest.updated to the check-in handler and logs each type's first delivery", /handleGuestCheckIn\(\{ \.\.\.data, event_api_id: eventId \}/.test(route) && /logFirstDelivery\(String\(type\), payload\)/.test(route) && /type === "guest\.updated"/.test(route));
  check("arrived_via accepts 'door' in code and in the migration", /via: "location" \| "text" \| "door"/.test(src("services/eventPresence.ts")) && /IN \('location', 'text', 'door'\)/.test(src("db/migrations.ts")));
  check("dedupe goes through inbound_webhook_handles", /INSERT INTO inbound_webhook_handles/.test(src("services/lumaCheckIn.ts")));
}

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
