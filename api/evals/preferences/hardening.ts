// Member preferences, hardening (2026-11-02): the member's zone from their home city, a held member's thread never hinted to the other
// side, rules said on a call applied to that call, the nightly rule check, and the team's hold. Zero tokens and no database: an
// in-memory store answers the queries these paths make.
//   npx tsx evals/preferences/hardening.ts
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
const G = await import("../../src/harness/notifyGate.js");
const P = await import("../../src/services/memberPreferences.js");
const MT = await import("../../src/services/memberTime.js");
const T = await import("../../src/services/teamHold.js");
const CP = await import("../../src/services/callPreferences.js");
const RC = await import("../../src/harness/ruleCompliance.js");
const RL = await import("../../src/services/relay.js");
const RM = await import("../../src/services/roomMatching.js");
const D = await import("../../src/services/deferredSends.js");
const { default: pool } = await import("../../src/db/db.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const SRC = new URL("../../src/", import.meta.url).pathname;
const src = (f: string) => readFileSync(SRC + f, "utf8");

// ---------------------------------------------------------------- an in-memory store
const db = {
  profiles: new Map<string, { city: string | null; timezone: string | null; timezone_city: string | null }>(),
  prefs: [] as any[],
  sends: [] as { user_id: string; type: string; sent_at: Date; notify_class: string | null }[],
  holds: [] as any[],
  memories: [] as { user_id: string; content: string }[],
  users: new Map<string, string>(),
  relays: [] as any[],
  pairs: [] as any[],
  closing: null as any,
};
const run = async (raw: string, a: any[] = []) => {
  const sql = raw.replace(/\s+/g, " ").trim();
  if (/^SELECT city, timezone, timezone_city FROM co_profiles/.test(sql)) { const p = db.profiles.get(a[0]); return { rows: p ? [p] : [] }; }
  if (/^UPDATE co_profiles SET timezone = \$2, timezone_city = \$3/.test(sql)) { const p = db.profiles.get(a[0]); if (p && p.city === a[2]) Object.assign(p, { timezone: a[1], timezone_city: a[2] }); return { rows: [] }; }
  if (/FROM users WHERE id = \$1/.test(sql) && /first_name/.test(sql)) return { rows: db.users.has(a[0]) ? [{ first_name: db.users.get(a[0]) }] : [] };
  if (/^SELECT phone_number FROM users|FROM person_snapshots|FROM member_claims/.test(sql)) return { rows: [] };
  if (/^SELECT id, object_label, happened_at, retired_at, meta FROM co_facts/.test(sql)) return { rows: db.prefs.filter((r) => r.owner_user_id === a[0] && (/retired_at IS NULL/.test(sql) ? !r.retired_at : true)) };
  if (/^SELECT id, retired_at FROM co_facts/.test(sql)) return { rows: db.prefs.filter((r) => r.owner_user_id === a[0] && r.retired_at) };
  if (/^SELECT type, sent_at, notify_class FROM proactive_sends/.test(sql)) return { rows: db.sends.filter((s) => s.user_id === a[0]) };
  if (/FROM harness_decisions/.test(sql)) return { rows: [] };
  if (/FROM team_holds WHERE user_id = \$1 AND lifted_at IS NULL AND set_at <= \$2 AND expires_at > \$2/.test(sql)) {
    const at = new Date(a[1]).getTime();
    return { rows: db.holds.filter((h) => h.user_id === a[0] && !h.lifted_at && h.set_at.getTime() <= at && h.expires_at.getTime() > at).sort((x, y) => y.expires_at - x.expires_at).slice(0, 1) };
  }
  if (/^INSERT INTO team_holds/.test(sql)) { const h = { id: db.holds.length + 1, user_id: a[0], set_by: a[1], category: a[2], set_at: a[3], expires_at: a[4], lifted_at: null }; db.holds.push(h); return { rows: [h] }; }
  if (/^INSERT INTO co_memories/.test(sql)) { db.memories.push({ user_id: a[0], content: a[1] }); return { rows: [] }; }
  if (/FROM member_relays r JOIN users/.test(sql)) return { rows: db.relays.filter((r) => r.from_user === a[0] || r.to_user === a[0]) };
  if (/^UPDATE event_room_closures SET claimed_at/.test(sql)) { const e = db.closing; db.closing = null; return { rows: e ? [e] : [] }; }
  if (/^UPDATE co_pairs SET state = 'expired'/.test(sql)) { const out = db.pairs.filter((x) => x.event_id === a[0] && ["suggested", "asked"].includes(x.state)); out.forEach((x) => (x.state = "expired")); return { rows: out }; }
  if (/^UPDATE co_pairs SET close_noted_at = \$2 WHERE event_id = \$1 AND state IN \('expired', 'declined'\) AND close_noted_at IS NULL/.test(sql)) { const out = db.pairs.filter((x) => x.event_id === a[0] && ["expired", "declined"].includes(x.state) && !x.close_noted_at); out.forEach((x) => (x.close_noted_at = a[1])); return { rows: out }; }
  if (/^SELECT .* FROM co_pairs/.test(sql)) return { rows: [] };
  return { rows: [] };
};
(pool as any).query = (s: string, a?: any[]) => run(s, a);
(pool as any).connect = async () => ({ query: (s: string, a?: any[]) => run(s, a), release: () => {} });
const reset = () => { db.profiles.clear(); db.prefs = []; db.sends = []; db.holds = []; db.memories = []; db.users.clear(); db.relays = []; };

const A = "00000000-0000-4000-8000-0000000000aa";
const B = "00000000-0000-4000-8000-0000000000bb";
let pid = 0;
const rule = (user: string, o: { covers?: string; area?: string; channel?: string; rule: any; zone?: string; setAt?: Date; retiredAt?: Date | null; state?: string }) => {
  db.prefs.push({ id: ++pid, owner_user_id: user, object_label: "their words", happened_at: o.setAt ?? new Date("2026-11-01T17:00:00Z"), retired_at: o.retiredAt ?? null, meta: { pref: 1, area: o.area ?? "contact", covers: o.covers ?? "all", channel: o.channel ?? "all", basis: "explicit", type: "standing", ruleRaw: o.rule, words: ["their words"], source: { via: "text", ref: null }, startsAt: (o.setAt ?? new Date("2026-11-01T17:00:00Z")).toISOString(), expiresAt: null, zone: o.zone ?? "America/Los_Angeles", ...(o.state ? { state: o.state } : {}) } });
  return String(pid);
};

// ---------------------------------------------------------------- 1. their zone from their home city (local place table first)
check("zone: New York, NY is Eastern from the local table", (await MT.localZoneFor("New York, NY")) === "America/New_York");
check("zone: a bare city read in their state (Cambridge in MA)", (await MT.localZoneFor("Cambridge", "MA")) === "America/New_York");
check("zone: Portland in Maine is Eastern, a bare Portland is Oregon's (the clearly bigger one)", (await MT.localZoneFor("Portland", "ME")) === "America/New_York" && (await MT.localZoneFor("Portland")) === "America/Los_Angeles");
check("zone: comparable same-named places in different zones are never guessed (the geocoder settles them)", (await MT.localZoneFor("Springfield")) === null && (await MT.localZoneFor("Cambridge")) === null);
check("zone: abroad too (London)", (await MT.localZoneFor("London, England")) === "Europe/London" || (await MT.localZoneFor("London")) === "Europe/London");
check("zone: an unknown place is null (the fallback zone applies)", (await MT.localZoneFor("Nowhereville Xq")) === null);
reset();
db.profiles.set(A, { city: "New York, NY", timezone: null, timezone_city: null });
check("memberZone: derived from the home city with no outside call, and stored with the city it came from", (await MT.memberZone(A)) === "America/New_York" && db.profiles.get(A)!.timezone === "America/New_York" && db.profiles.get(A)!.timezone_city === "New York, NY");
db.profiles.get(A)!.city = "Austin, TX";
check("memberZone: a move re-derives and stores the new zone", (await MT.memberZone(A)) === "America/Chicago" && db.profiles.get(A)!.timezone === "America/Chicago" && db.profiles.get(A)!.timezone_city === "Austin, TX");
db.profiles.set(B, { city: null, timezone: null, timezone_city: null });
check("memberZone: no city, no zone: the gate measures in the fallback (Pacific)", (await MT.memberZone(B)) === null && MT.wordsZone(null) === MT.FALLBACK_ZONE);

// What they stated beats the phone's area code (review of #363): Dallas with a Pittsburgh (412) number is Dallas, Texas.
const said: { stated: string; phone: string }[] = [];
const note = (d: { stated: string; phone: string }) => said.push(d);
check("zone: their stated state decides (Dallas, TX with a 412 number is Central)", (await MT.cityZone("Dallas", { stated: "TX", phone: "PA" }, note)) === "America/Chicago" && said.length === 0);
check("zone: no stated state: the city alone beats the phone (Dallas with a 412 number is still Central)", (await MT.cityZone("Dallas", { stated: null, phone: "PA" }, note)) === "America/Chicago");
check("zone: the phone only settles a city the table can't (a bare Cambridge with a 617 number)", (await MT.cityZone("Cambridge", { stated: null, phone: "MA" }, note)) === "America/New_York" && said.length === 0);
check("zone: a real town by that name in the phone's state wins over a bigger one elsewhere (Portland with a 207 number is Maine), and the disagreement is logged (zones only)", (await MT.cityZone("Portland", { stated: null, phone: "ME" }, note)) === "America/New_York" && said.length === 1 && said[0].stated === "America/Los_Angeles" && said[0].phone === "America/New_York");
check("zone: a phone state with no such town (or one under the floor) changes nothing: the city alone", (await MT.cityZone("Dallas", { stated: null, phone: "PA" }, note)) === "America/Chicago" && (await MT.localZoneFor("Portland", "ME", { minPopulation: 10_000_000 })) === null);
check("zone: memberZone reads stated places apart from the phone", /stated: regionFor\(\{ city: rows\[0\]\.city, places: [\s\S]{0,80}\}\), phone: stateForPhone\(/.test(src("services/memberTime.ts")));

// A non-Pacific member through the real gate (memberRuleGate reads their zone itself).
reset();
db.profiles.set(A, { city: "New York, NY", timezone: null, timezone_city: null });
db.profiles.set(B, { city: "San Francisco, CA", timezone: null, timezone_city: null });
rule(A, { rule: { earliest: "09:00" } });
rule(B, { rule: { earliest: "09:00" } });
const nineThirtyET = new Date("2026-11-03T14:30:00Z"); // 9:30 New York, 6:30 San Francisco
let g = await G.memberRuleGate(pool as any, { userId: A, now: nineThirtyET, cls: "unsolicited", channel: "text" });
check("non-Pacific: 'nothing before 9' lets a 9:30 New York send go", g.pass === true);
g = await G.memberRuleGate(pool as any, { userId: B, now: nineThirtyET, cls: "unsolicited", channel: "text" });
check("the same moment is 6:30 for the San Francisco member: held until their 9", g.pass === false && g.retryAt?.toISOString() === "2026-11-03T17:00:00.000Z");
reset();
db.profiles.set(A, { city: "New York, NY", timezone: null, timezone_city: null });
db.profiles.set(B, { city: "San Francisco, CA", timezone: null, timezone_city: null });
rule(A, { rule: { max_per_day: 1 } });
rule(B, { rule: { max_per_day: 1 } });
for (const u of [A, B]) db.sends.push({ user_id: u, type: "event_offer", sent_at: new Date("2026-11-04T03:30:00Z"), notify_class: "unsolicited" }); // 22:30 Nov 3 ET, 19:30 Nov 3 PT
const halfPastMidnightET = new Date("2026-11-04T05:30:00Z"); // 00:30 Nov 4 ET, 21:30 Nov 3 PT
g = await G.memberRuleGate(pool as any, { userId: A, now: halfPastMidnightET, cls: "unsolicited", channel: "text" });
check("local-day count: after midnight in New York it's a new day there (one a day allows this)", g.pass === true);
g = await G.memberRuleGate(pool as any, { userId: B, now: halfPastMidnightET, cls: "unsolicited", channel: "text" });
check("local-day count: still the same day in San Francisco (held to their tomorrow)", g.pass === false && g.retryAt?.toISOString() === "2026-11-04T08:00:00.000Z");

// ---------------------------------------------------------------- 2. a held member's thread never hinted to the other side
// Relay (A passes a message to B): the sender's facts and notes read the same whether it went or B's hours or rule held it.
const sentFact = RL.relaySenderFact({ to: "Ellis", day: "Monday, Nov 2", message: "running late", back: null });
check("relay: the sender's fact never says waiting, queued, morning, hours, rule or 'reached'", !/queued|morning|hours|rule|hasn't reached|NOT reached|waiting/i.test(sentFact.replace("Never say when it reached Ellis or whether it has yet.", "")));
check("relay: the sender's note is one line for every outcome, and says nothing about the other side's hours or settings", RL.relaySenderNote("Ellis") === RL.relaySenderNote("Ellis") && /Never say when it reaches Ellis/.test(RL.relaySenderNote("Ellis")) && !/morning|queued|outside their hours/.test(RL.relaySenderNote("Ellis")));
{
  process.env.CO_RELAY = "on";
  reset();
  const at = new Date("2026-11-02T18:00:00Z");
  db.relays.push({ from_user: A, to_user: B, message: "running late", status: "queued", created_at: at, asked_at: at, from_name: "Jordan", to_name: "Ellis" });
  const held = await RL.relayFacts(A);
  // Delivered the next morning (their hours or their rule held it overnight): the sender's line, date included, must not move.
  Object.assign(db.relays[0], { status: "sent", created_at: new Date("2026-11-03T16:00:00Z") });
  const went = await RL.relayFacts(A);
  check("relay: A's facts are identical whether B's send is held or went", held.length === 1 && JSON.stringify(held) === JSON.stringify(went));
  db.relays[0].status = "queued";
  check("relay: B's side knows nothing until it reaches them", (await RL.relayFacts(B)).length === 0);
  delete process.env.CO_RELAY;
}
check("relay tool: one line to the sender's turn whatever the outcome (no 'morning', no 'queued')", !/in their morning|Queued their words/.test(src("agent/conversationTools.ts")) && /Took their words for \$\{r\.to\}/.test(src("agent/conversationTools.ts")));

// Room: a Cue-suggested intro one side said yes to. The other side's ask held (their hours or rule) until the night ended, or sent and
// never answered: the yes side hears the same thing, from the close, never from the dropped ask.
reset();
db.users.set(B, "Ellis");
await D.afterHandlers.event_direct_ask({ eventId: "evt-1", candidateId: B, askerId: A }, "skipped", D.EVENT_OVER);
check("room: an ask the other side's hold carried past the night's end writes nothing to the asker", db.memories.length === 0);
// The close itself, run three times: the other side's ask held past the night (pair still 'suggested'), sent and never answered ('asked'),
// and answered no ('declined'). What the yes side ends up with must be identical (review of #363: a "no" must read like silence).
const closeWith = async (state: string, b_answer: string | null) => {
  db.memories = [];
  db.pairs = [{ id: 1, event_id: "evt-9", origin: "co", a_id: A, b_id: B, a_answer: "yes", b_answer, state }];
  db.closing = { event_id: "evt-9", event_name: "Supper Club", ends_at: new Date("2026-11-03T06:00:00Z") };
  await RM.runRoomCloses(new Date("2026-11-03T06:30:00Z"));
  return JSON.stringify(db.memories);
};
reset();
db.users.set(B, "Ellis");
const heldClose = await closeWith("suggested", null);
const silentClose = await closeWith("asked", null);
const declinedClose = await closeWith("declined", "no");
// A close run again after a crash (the room's claim went stale): no second note for anyone, so a re-run can't set a "no" apart.
const twice = async (state: string, b_answer: string | null) => {
  await closeWith(state, b_answer);
  db.closing = { event_id: "evt-9", event_name: "Supper Club", ends_at: new Date("2026-11-03T06:00:00Z") };
  await RM.runRoomCloses(new Date("2026-11-03T06:45:00Z"));
  return JSON.stringify(db.memories);
};
const reHeld = await twice("suggested", null), reSilent = await twice("asked", null), reDeclined = await twice("declined", "no");
check("room: a close run twice adds no note (held, silent and declined alike: one note each, identical)", reHeld === reSilent && reSilent === reDeclined && JSON.parse(reDeclined).length === 1);
check("room: held, silent and declined leave the asker exactly the same record", heldClose === silentClose && silentClose === declinedClose && JSON.parse(heldClose).length === 1 && JSON.parse(heldClose)[0].user_id === A);
check("room: that record says it didn't happen, never whether they got it, saw it, answered or why", /didn't happen this time/.test(heldClose) && /Never say whether Ellis got the ask/.test(heldClose) && !/held|rule|hours|didn't go out|queued|passed|declin|said no/i.test(JSON.parse(heldClose)[0].content.replace(/Never say[\s\S]*$/, "")));
db.memories = [];
db.pairs = [{ id: 2, event_id: "evt-9", origin: "member", a_id: A, b_id: B, a_answer: "yes", b_answer: "no", state: "declined" }, { id: 3, event_id: "evt-9", origin: "member", a_id: A, b_id: B, a_answer: "yes", b_answer: null, state: "asked" }];
db.closing = { event_id: "evt-9", event_name: "Supper Club", ends_at: new Date("2026-11-03T06:00:00Z") };
await RM.runRoomCloses(new Date("2026-11-03T06:30:00Z"));
check("room: a pair the member asked for by name gets no close note, declined or not (found/not found never leaks)", db.memories.length === 0);
check("room: the decider's side and a both-yes pair get none", RM.closeNoteFor({ origin: "co", a_id: A, b_id: B, a_answer: "yes", b_answer: "no" })?.to === A && RM.closeNoteFor({ origin: "co", a_id: A, b_id: B, a_answer: "yes", b_answer: "yes" }) === null && RM.closeNoteFor({ origin: "co", a_id: A, b_id: B, a_answer: "no", b_answer: null }) === null);
check("room: the deferred runner passes the drop's reason to the after-step (so 'event over' is known)", /await runAfter\(after, o, deps\.handlers, o === "sent" \? undefined : result\.reason\)/.test(src("services/deferredSends.ts")));
// A held send is requeued, never settled: no after-step runs for a hold (so nothing reaches the asker while it waits).
check("room + network: a held deferred send is requeued before any after-step", /if \(!result\.sent && result\.reason\?\.startsWith\("held:"\) && heldUntil\) \{\n\s*await requeue\(heldUntil, null\);\n\s*out\.requeued\+\+;\n\s*continue;/.test(src("services/deferredSends.ts")));
// Network: the asker's line is fixed, whatever happened to the ask.
check("network: the asker hears the same line whether the ask went or is held", /await askCandidateDirectly\(candidateInfo, person, pending\.candidate\.match_reason, pending\.askId\);\n\s*return \{ state: "asked", how, context: `\\nThey just said yes to being connected with \$\{pending\.candidate\.first_name\}\. Acknowledge it warmly and briefly — you're now waiting to hear back/.test(src("services/networkIntroNudge.ts")));
// Outside events (no room clock): a held ask is never dropped as "event over", so no note can come from it.
check("outside event: an event with no timing is never over (a held ask waits for the rule instead)", /if \(!t\) return false;|return false;/.test(src("services/roomMatching.ts").slice(src("services/roomMatching.ts").indexOf("export async function eventOver"), src("services/roomMatching.ts").indexOf("export async function eventOver") + 600)));
// The gate's own reason never leaves the held member's record.
check("held reasons are logged under the held member only", /recordDecision\(\{ layer: 7, decision: "proactive\.exemptSend", userId: o\.userId/.test(src("harness/proactive.ts")));

// ---------------------------------------------------------------- 3. rules said on a call apply to that same call
check("unread lines: a turn read whole is gone, one that grew keeps only what it gained", JSON.stringify(CP.unreadOf(["keep it short", "keep it short and also no calls Sunday", "hello"], ["keep it short", "keep it short"])) === JSON.stringify(["and also no calls Sunday", "hello"]));
CP.resetCallReads();
const stored: Record<string, any> = {};
const captured: string[] = [];
let failNext = false;
const mk = (id: string, area: string, r: any, channel = "all", covers = "unsolicited"): any => ({ id, area, channel, covers, rule: r, basis: "explicit", type: "standing", words: ["w"], source: { via: "call", ref: "gpt-live:s1" }, startsAt: null, expiresAt: "2026-11-08T07:59:59.999Z", zone: "America/New_York", state: "active", setAt: new Date().toISOString() });
CP.setCallReadDeps({
  zone: async () => "America/New_York",
  capture: async (_u, words) => {
    if (failNext) { failNext = false; throw new Error("read failed"); }
    captured.push(words);
    if (/keep it short/i.test(words)) { stored["11"] = mk("11", "reply_style", { style: "keep it short" }); return { added: ["11"], retired: [] }; }
    if (/don't call me again this week/i.test(words)) { stored["12"] = mk("12", "contact", { none: true }, "call", "all"); return { added: ["12"], retired: [] }; }
    return { added: [], retired: [] };
  },
  load: async () => Object.values(stored),
  loadRetired: async () => [],
  record: () => {},
});
const turn = (who: "member" | "cue", text: string, at: number): any => ({ who, text, startMs: at, endMs: at + 500 });
const sys = [{ role: "system", content: "the call prompt" }, { role: "user", content: "keep it short, I'm walking" }];
let p = CP.readCallTurn({ callKey: "gpt-live:s1", userId: A, turns: [turn("member", "keep it short, I'm walking", 0)], safety: false });
check("a call turn's read starts beside the thinking (a promise the turn doesn't await)", p instanceof Promise);
check("before it lands, the turn goes as it was (nothing waits on the read)", CP.callRuleNote("gpt-live:s1", sys) === null);
await p;
const withNote = CP.withCallRuleNote("gpt-live:s1", sys);
check("'keep it short' shapes the remaining answers: the thinking's system prompt carries it", withNote[0].content.includes("How to answer them: replies: keep it short") && withNote[0].content.includes("rest of this call") && withNote[1] === sys[1]);
check("the call's note never says 'not applied yet' for what it applies on this call", !/not applied yet/.test(withNote[0].content));
const safetyMsgs = [{ role: "system", content: "the call prompt" }, { role: "user", content: "honestly I want to kill myself" }];
check("a safety turn gets no note: the crisis path is untouched", CP.withCallRuleNote("gpt-live:s1", safetyMsgs) === safetyMsgs);
check("a safety turn is never read mid-call (no read, no added latency)", CP.readCallTurn({ callKey: "gpt-live:s1", userId: A, turns: [turn("member", "keep it short, I'm walking", 0), turn("member", "I want to kill myself", 2000)], safety: true }) === null && captured.length === 1);
p = CP.readCallTurn({ callKey: "gpt-live:s1", userId: A, turns: [turn("member", "keep it short, I'm walking", 0), turn("cue", "Got it.", 800), turn("member", "and don't call me again this week", 2000)], safety: false });
await p;
check("a later read takes only the new words (never re-reads what a read took)", captured.length === 2 && captured[1] === "and don't call me again this week");
const callRule = Object.values(stored).find((x) => x.id === "12");
const dial = G.memberRuleCheck([callRule], { now: new Date("2026-11-04T18:00:00Z"), cls: "checkin", channel: "call", sent: [] });
const textAfter = G.memberRuleCheck([callRule], { now: new Date("2026-11-04T18:00:00Z"), cls: "unsolicited", channel: "text", sent: [] });
check("'don't call me again this week' stored mid-call holds the follow-up dials (the call gate reads it fresh)", dial.pass === false && textAfter.pass === true);
check("…and the thinking is told it's on file, so it doesn't promise a call", /no calls from me[\s\S]*It's on file now/.test(CP.withCallRuleNote("gpt-live:s1", sys)[0].content));
failNext = true;
await CP.readCallTurn({ callKey: "gpt-live:s1", userId: A, turns: [turn("member", "keep it short, I'm walking", 0), turn("member", "and don't call me again this week", 2000), turn("member", "texts only after ten please", 4000)], safety: false });
const theirs = ["keep it short, I'm walking", "and don't call me again this week", "I want to kill myself", "texts only after ten please", "bye"].join("\n");
const unread = await CP.unreadCallerLines("gpt-live:s1", theirs);
check("after the call: only lines no mid-call read took go to the fallback (the failed read's, the safety turn's, the last words)", unread === ["I want to kill myself", "texts only after ten please", "bye"].join("\n"));
check("a call with no mid-call reads on record: the fallback reads every line, as before", (await CP.unreadCallerLines("gpt-live:other", theirs)) === null);
check("the fallback stores rules only from unread lines (no double capture)", /const prefLines = unread \?\? theirLines\(input\.transcript\);[\s\S]{0,200}learnPreferences\(input\.userId, learned\.preferences, \{ message: prefLines/.test(src("services/callLearning.ts")) && /callKey: o\.callKey \}\)/.test(src("routes/co.ts")));
check("the bridge starts the read before the thinking and never awaits it", /d\.readRules\(\{ callKey: rulesKey, userId: c\.userId, turns, safety: safetyCall\(delegationRequest\(c, turns\)\) \}\);[\s\S]{0,900}withCallRuleNote\(rulesKey, guarded\)[\s\S]*const out = await thinkOnCall\(/.test(src("services/gptLiveBridge.ts")) && !/await d\.readRules/.test(src("services/gptLiveBridge.ts")));
check("the read on a call is told it's a call", /on a phone call they're on now/.test(P.preferenceReadPrompt({ words: "x", onFile: [], localToday: "2026-11-02", via: "call" })) && /texted Cue/.test(P.preferenceReadPrompt({ words: "x", onFile: [], localToday: "2026-11-02" })));
CP.setCallReadDeps(null);
CP.resetCallReads();

// ---------------------------------------------------------------- 4. the nightly rule check (read-only)
const at = (iso: string) => new Date(iso);
const hp = (id: string, r: any, setAt: string, retiredAt: string | null = null, o: any = {}): any => ({ ...mk(id, "contact", r, o.channel ?? "all", o.covers ?? "all"), setAt, retiredAt: retiredAt ? new Date(retiredAt) : null, expiresAt: null, zone: "America/New_York" });
const s = (ref: string, iso: string, type: string, cls: any, channel: "text" | "call" = "text", safety = false) => ({ ref, at: at(iso), type, cls, channel, safety });
const prefsH = [hp("21", { maxPerDay: 1 }, "2026-11-02T12:00:00Z")];
const win = [s("send 1", "2026-11-02T15:00:00Z", "event_offer", "unsolicited"), s("send 2", "2026-11-02T17:00:00Z", "task_update", "requested"), s("send 3", "2026-11-02T18:00:00Z", "reply", "reply"), s("send 4", "2026-11-02T19:00:00Z", "companion", "checkin", "text", true)];
let br = RC.checkMember({ userId: A, prefs: prefsH, holds: [], history: win.map((w) => ({ at: w.at, cls: w.cls, channel: w.channel })), window: win, zone: "America/New_York" });
check("rule check: the second message of a one-a-day day is flagged, with its send path and the rule's id", br.length === 1 && br[0].ref === "send 2" && br[0].path === "text:task_update" && br[0].cls === "requested" && /rule 21: 1 of 1 today/.test(br[0].why) && br[0].severity === "high");
check("rule check: replies and safety follow-ups are never flagged", !br.some((b) => b.ref === "send 3" || b.ref === "send 4"));
br = RC.checkMember({ userId: A, prefs: [hp("22", { maxPerDay: 1 }, "2026-11-02T16:30:00Z")], holds: [], history: win.map((w) => ({ at: w.at, cls: w.cls, channel: w.channel })), window: win, zone: "America/New_York" });
check("rule check: judged by the rules as they stood at the send (a rule set later counts what went before, as the gate does)", br.length === 1 && br[0].ref === "send 2");
br = RC.checkMember({ userId: A, prefs: [hp("23", { maxPerDay: 1 }, "2026-11-02T12:00:00Z", "2026-11-02T16:00:00Z")], holds: [], history: win.map((w) => ({ at: w.at, cls: w.cls, channel: w.channel })), window: win, zone: "America/New_York" });
check("rule check: a rule withdrawn before the send doesn't flag it", br.length === 0);
br = RC.checkMember({ userId: A, prefs: prefsH, holds: [], history: [], window: [s("send 9", "2026-11-02T15:00:00Z", "call_reminder", "requested"), s("send 10", "2026-11-02T15:30:00Z", "call_reminder", "requested")], zone: "America/New_York" });
check("rule check: what the record can't settle (a notice about something within hours) is flagged low with why", (() => { const b = RC.checkMember({ userId: A, prefs: [hp("24", { none: true }, "2026-11-02T12:00:00Z")], holds: [], history: [], window: [s("send 9", "2026-11-02T15:00:00Z", "call_reminder", "requested")], zone: "America/New_York" }); return b.length === 1 && b[0].severity === "low" && /time-sensitive/.test(b[0].caveat ?? ""); })());
br = RC.checkMember({ userId: A, prefs: [], holds: [{ id: "5", setAt: at("2026-11-02T10:00:00Z"), expiresAt: at("2026-11-03T10:00:00Z"), liftedAt: null }], history: [], window: win, zone: null });
check("rule check: Cue's own send inside a team hold is flagged; what they asked for, replies and safety aren't", br.length === 1 && br[0].ref === "send 1" && /team_hold 5/.test(br[0].why));
br = RC.checkMember({ userId: A, prefs: [], holds: [{ id: "5", setAt: at("2026-11-02T10:00:00Z"), expiresAt: at("2026-11-03T10:00:00Z"), liftedAt: null }], history: [], window: [{ ...s("send 11", "2026-11-02T15:00:00Z", "direct_ask", "unsolicited"), relay: true }], zone: null });
check("rule check: a relay inside a team hold isn't flagged (it goes through the hold)", br.length === 0);
check("rule check: safety is read from the send's own candidate (its ledger row's candidate_id), not another with the same key", /LEFT JOIN proactive_candidates c ON c\.id = s\.candidate_id AND c\.user_id = s\.user_id/.test(src("harness/ruleCompliance.ts")) && !/ORDER BY pc\.id DESC LIMIT 1/.test(src("harness/ruleCompliance.ts")));
const flag = RC.breakFlag({ userId: A, ref: "send 2", at: "2026-11-02T17:00:00.000Z", path: "text:task_update", cls: "requested", why: "rule 21: 1 of 1 today", severity: "high", caveat: null });
check("rule check: the review flag carries ids and paths only", flag.type === "member_rule_broken" && flag.snippet === "send 2 via text:task_update (requested)" && /send path text:task_update/.test(flag.cause) && !/their words/.test(JSON.stringify(flag)));
check("rule check: on the review (whatBroke/morning), nightly, and on the /sweeps page", /ruleCompliance\.js"\)\.then\(\(R\) => R\.ruleBreaks\(since, until, \{ userIds: \[userId\] \}\)/.test(src("harness/devReview.ts")) && /runNightlyRuleCheck\(\)/.test(src("jobs/index.ts")) && /\/rule-checks/.test(readFileSync(SRC + "../../co-test/src/routes/sweeps.ts", "utf8")));
check("rule check: read-only (no UPDATE, DELETE or send in it)", !/UPDATE |DELETE |INSERT |sendblue|sendExempt/.test(src("harness/ruleCompliance.ts").replace(/storeFlags/g, "")));

// ---------------------------------------------------------------- 5. the team's hold
reset();
const now = new Date("2026-11-03T18:00:00Z");
const ok = (o: any) => T.holdProblem({ setBy: "royce", category: "tester", expiresAt: new Date(now.getTime() + 3600e3), now, ...o });
check("hold: needs who, a fixed category (never free text) and a real expiry within 30 days", ok({ setBy: "" }) !== null && ok({ category: "she's having a rough week" }) !== null && ok({ expiresAt: new Date(now.getTime() - 1) }) !== null && ok({ expiresAt: new Date(now.getTime() + 31 * 86_400_000) }) !== null && ok({}) === null && T.HOLD_CATEGORIES.every((c) => ok({ category: c }) === null));
const hold = await T.setTeamHold({ userId: A, setBy: "royce", category: "hard_moment", expiresAt: new Date(now.getTime() + 48 * 3600e3), now });
check("hold: recorded with who set it and its category, no notes about the member", hold.setBy === "royce" && hold.category === "hard_moment" && db.holds.length === 1 && !("reason" in db.holds[0]) && !("reason" in hold));
let threw = false;
try { await T.setTeamHold({ userId: A, setBy: "royce", category: "free text here", expiresAt: new Date(now.getTime() + 3600e3), now }); } catch { threw = true; }
check("hold: a category outside the list is refused before anything is written", threw && db.holds.length === 1);
check("hold: the table enforces the category and the 30-day cap too (additive, idempotent CHECK)", /category TEXT NOT NULL CHECK \(category IN \('tester', 'hard_moment', 'member_asked_offline', 'other'\)\)/.test(src("db/migrations.ts")) && /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'team_holds_max_30_days'\)[\s\S]{0,200}CHECK \(expires_at > set_at AND expires_at <= set_at \+ INTERVAL '30 days'\) NOT VALID/.test(src("db/migrations.ts")));
for (const cls of ["unsolicited", "checkin"] as const) {
  g = await G.memberRuleGate(pool as any, { userId: A, now, cls, channel: "text" });
  check(`hold: holds Cue's own ${cls} text until it expires`, g.pass === false && g.retryAt?.getTime() === hold.expiresAt.getTime() && g.name === G.MEMBER_RULE);
}
g = await G.memberRuleGate(pool as any, { userId: A, now, cls: "requested", channel: "text" });
check("hold: what they asked for (a document, a reminder they set) still goes", g.pass === true);
g = await G.memberRuleGate(pool as any, { userId: A, now, cls: "unsolicited", channel: "text", throughTeamHold: true });
check("hold: a relay (another member's own words) goes through the hold", g.pass === true);
check("hold: a relay is known by its ledger key, and sendExempt passes it through (in-room texts don't)", G.isRelayKey("relay:42") && !G.isRelayKey("in_room:match:evt:1") && /throughTeamHold: isRelayKey\(opts\.targetKey\)/.test(src("harness/proactive.ts")) && !/throughTeamHold/.test(src("harness/proactive.ts").slice(src("harness/proactive.ts").indexOf("export async function inRoomSendAllowed"))));
g = await G.memberRuleGate(pool as any, { userId: A, now, cls: "unsolicited", channel: "text" });
check("hold: an in-room text (Cue's own, no pass-through) stays held", g.pass === false);
g = await G.memberRuleGate(pool as any, { userId: A, now, cls: "requested", channel: "call" });
check("hold: a call they booked still goes", g.pass === true);
g = await G.memberRuleGate(pool as any, { userId: A, now, cls: "requested", channel: "text", soonAt: new Date(now.getTime() + 3600e3) });
check("hold: a notice about something soon still goes", g.pass === true);
rule(A, { rule: { max_per_day: 0 } });
g = await G.memberRuleGate(pool as any, { userId: A, now, cls: "requested", channel: "text" });
check("hold: what passes the hold still answers to their own rules", g.pass === false && /member's own rule/.test(String(g.reason)));
g = await G.memberRuleGate(pool as any, { userId: A, now, cls: "unsolicited", channel: "text", throughTeamHold: true });
check("hold: a relay through the hold still answers to the receiving member's own rules", g.pass === false && /member's own rule/.test(String(g.reason)));
db.prefs = [];
g = await G.memberRuleGate(pool as any, { userId: A, now, cls: "checkin", channel: "call" });
check("hold: holds calls Cue places", g.pass === false);
g = await G.memberRuleGate(pool as any, { userId: A, now, cls: "reply", channel: "text" });
check("hold: the reply to their own text still goes", g.pass === true);
check("hold: a safety follow-up still goes (the pick skips the gate for it)", /if \(!isSafetyFollowUp\(c\)\) \{\n\s*const \{ retryAt: _r, \.\.\.rule \} = await memberRuleGate/.test(src("harness/proactive.ts")));
check("hold: the gate's log line is its id only", /^team_hold \d+ holds it$/.test(String((await G.memberRuleGate(pool as any, { userId: A, now, cls: "unsolicited", channel: "text" })).reason)));
g = await G.memberRuleGate(pool as any, { userId: A, now: new Date(hold.expiresAt.getTime() + 1000), cls: "unsolicited", channel: "text" });
check("hold: gone at its expiry", g.pass === true);
g = await G.memberRuleGate(pool as any, { userId: B, now, cls: "unsolicited", channel: "text" });
check("hold: one member's hold never holds another's send", g.pass === true);
// Never theirs: no member-facing path reads it.
const readers: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p2 = join(d, f);
    if (statSync(p2).isDirectory()) { walk(p2); continue; }
    if (/\.ts$/.test(f) && /team_holds|teamHold\.js/.test(readFileSync(p2, "utf8"))) readers.push(p2.replace(SRC, ""));
  }
};
walk(SRC);
check("hold: read only by the send gate, the rule check and the team's script (never what Cue knows, a reply or a call's context)", readers.sort().join(",") === ["db/migrations.ts", "harness/notifyGate.ts", "harness/ruleCompliance.ts", "scripts/teamHold.ts", "services/teamHold.ts"].join(","));
check("hold: separate from their rules (its own table, never co_facts)", !/co_facts/.test(src("services/teamHold.ts").replace(/never co_facts/g, "")));

console.log(`preferences hardening: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
