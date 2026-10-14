// Suite 2: event flows. Luma responses are fixtures at the HTTP boundary;
// Co test events (co_test_events, ids "test-…") are production's own seam for
// members and locations. No real guests, no real shared locations.
import { H } from "./boot.js";
import { settle } from "./db.js";
import { member, rows, ck, intent, PHONE, ID, NAME, type Case } from "./fixtures.js";

const iso = (ms: number) => new Date(ms).toISOString();
function lumaEvents(list: { id: string; name: string; start: number; end: number | null }[]) {
  H.respond = (t, path) => {
    if (t !== "luma") return null;
    if (path.startsWith("/v1/calendars/events/list")) return { status: 200, body: { entries: list.map((e) => ({ event: { id: e.id, name: e.name, start_at: iso(e.start), end_at: e.end ? iso(e.end) : null, timezone: "America/Los_Angeles" } })), has_more: false } };
    const m = path.match(/api_id=([^&]+)/);
    const ev = m && list.find((e) => e.id === decodeURIComponent(m[1]));
    if (path.startsWith("/v1/event/get")) return ev ? { status: 200, body: { event: { api_id: ev.id, name: ev.name, start_at: iso(ev.start), end_at: ev.end ? iso(ev.end) : null } } } : { status: 404, body: {} };
    if (path.startsWith("/v1/events/guests/list")) return { status: 200, body: { entries: [] } };
    return null;
  };
}
async function testEvent(id: string, name: string, start: number, end: number | null, guests: string[], lat = 37.7749, lng = -122.4194) {
  await rows(`INSERT INTO co_test_events (api_id, name, start_at, end_at, timezone, venue, latitude, longitude, guest_user_ids) VALUES ($1, $2, $3, $4, 'America/Los_Angeles', 'Test venue', $5, $6, $7::uuid[])`, [id, name, iso(start), end ? iso(end) : null, lat, lng, guests]);
}

export const events: Case[] = [
  {
    suite: "events", id: "event-checkin-window", mode: "model-free", runs1: true,
    run: async () => {
      const W = await import("../../src/services/eventWalkinCheckin.js");
      const now = Date.now();
      const start = now + 60 * 60_000, end = start + 2 * 3600_000;
      const ev = { start_at: iso(start), end_at: iso(end) };
      const open = (t: number) => W.isCheckinOpen(ev, new Date(t));
      const opensAt = start - W.CHECKIN_OPENS_BEFORE_START_MINUTES * 60_000;
      // Phrase detection against the (fixture) calendar: one open event, one over, two similar.
      lumaEvents([
        { id: "evt-hw", name: "Climate Hardware Night", start: now - 30 * 60_000, end: now + 2 * 3600_000 },
        { id: "evt-old", name: "Climate Hardware Breakfast", start: now - 26 * 3600_000, end: now - 24 * 3600_000 },
        { id: "evt-fd1", name: "Founders Dinner", start: now - 10 * 60_000, end: now + 3 * 3600_000 },
        { id: "evt-fd2", name: "Founders Dinner Afterparty", start: now + 60 * 60_000, end: now + 4 * 3600_000 },
      ]);
      const hit = await W.detectCheckinPhrase("I'm at a Cue event, Climate Hardware Night");
      const ended = await W.detectCheckinPhrase("I'm at a Cue event, Climate Hardware Breakfast");
      const ambiguous = await W.detectCheckinPhrase("I'm at a Cue event, the founders dinner");
      const noPhrase = await W.detectCheckinPhrase("at climate hardware night");
      // A recommendation alone is never attendance.
      const M = await import("../../src/services/eventMatching.js");
      const only = M.attendeesOnly([{ user_id: ID.A, event_api_id: "evt-hw", source: "surfaced" }, { user_id: ID.B, event_api_id: "evt-hw", source: "mention" }]);
      return {
        checks: [
          ck(`closed 1ms before the ${W.CHECKIN_OPENS_BEFORE_START_MINUTES}-minute opening, open exactly at it`, !open(opensAt - 1) && open(opensAt)),
          ck("open at the end, closed 1ms after", open(end) && !open(end + 1)),
          ck("no end time: open until start + 12h", W.isCheckinOpen({ start_at: iso(start) }, new Date(start + 12 * 3600_000)) && !W.isCheckinOpen({ start_at: iso(start) }, new Date(start + 12 * 3600_000 + 1))),
          ck("the open event is found by name", hit?.eventApiId === "evt-hw", hit),
          ck("an event that's over can't be checked into", ended === null || ended.eventApiId !== "evt-old", ended),
          ck("the check-in phrase is required", noPhrase === null, noPhrase),
          ck("a surfaced recommendation is not attendance", only.length === 1 && only[0].user_id === ID.B, only),
        ],
        observed: { ambiguousFoundersDinner: ambiguous, note: "Two similar open events: the function returns one (highest overlap, then earliest start) without asking which." },
      };
    },
  },
  {
    suite: "events", id: "event-walkin-dedupe", runs1: true,
    run: async () => {
      await member("A", { profile: { intent: intent([]) } });
      await member("B", { profile: { intent: intent([{ text: "investors who back hardware", type: "seeking" }]) } });
      const W = await import("../../src/services/eventWalkinCheckin.js");
      const S = await import("../../src/services/eventScoring.js");
      const r1 = await W.recordCheckin("evt-hw", ID.A);
      const r2 = await W.recordCheckin("evt-hw", ID.A);
      await W.recordCheckin("evt-hw", ID.B);
      await W.recordWalkinAsk("evt-hw", ID.A, "I'm looking for a technical cofounder who's built battery hardware");
      await settle();
      const checkins = await rows(`SELECT person_id, ask_text FROM event_walkin_checkins ORDER BY person_id`);
      const pool = await W.mergeWalkinsIntoGuestPool("evt-hw");
      // B is also on the registered list.
      const registered = [{ user_id: ID.B, first_name: NAME.B, phone_number: PHONE.B, email: "jordan.b@co.invalid" }];
      const merged = S.dedupeByUserId([...(registered as any), ...pool]);
      const intents = await rows(`SELECT user_id, intent FROM co_profiles ORDER BY user_id`);
      const aIntent = intents.find((r: any) => r.user_id === ID.A)?.intent ?? [];
      const bIntent = intents.find((r: any) => r.user_id === ID.B)?.intent ?? [];
      return {
        checks: [
          ck("first check-in is new, the repeat isn't", r1.isNew && !r2.isNew),
          ck("one check-in row per person", checkins.length === 2, checkins),
          ck("the walk-in ask is on A's own check-in", checkins.find((c: any) => c.person_id === ID.A)?.ask_text?.includes("cofounder") && !checkins.find((c: any) => c.person_id === ID.B)?.ask_text, checkins),
          ck("registered + walk-in B counts once", merged.filter((g: any) => g.user_id === ID.B).length === 1 && merged.length === 2, merged.map((g: any) => g.user_id)),
          ck("A's ask landed in A's profile only", JSON.stringify(aIntent).includes("cofounder") && !JSON.stringify(bIntent).includes("cofounder"), { aIntent, bIntent }),
        ],
      };
    },
  },
  {
    suite: "events", id: "event-presence-stale", runs1: true,
    replaced: ["Sendblue /api/location: fixture response at the HTTP boundary"],
    run: async () => {
      const P = await import("../../src/services/eventPresence.js");
      const now = Date.now();
      const fresh = { number: PHONE.A, state: "shared_with_fix", location: { latitude: 37.7749, longitude: -122.4194, accuracy: 20, timestamp: iso(now - 60_000) } };
      const stale = { number: PHONE.B, state: "shared_with_fix", location: { latitude: 37.7749, longitude: -122.4194, accuracy: 20, timestamp: iso(now - P.MAX_FIX_AGE_MS - 60_000) } };
      const revoked = { number: PHONE.C, state: "not_shared" };
      const parsed = P.parseSharedLocations({ locations: [fresh, stale, revoked] }, new Date(now));
      // Dwell: near for less than 4 minutes isn't arrival; 4 minutes is.
      const s0 = { near_since: null, arrived_at: null, away_since: null, left_at: null };
      const a = P.nextPresence(s0, true, new Date(now));
      const b = P.nextPresence(a.state, true, new Date(now + P.ARRIVE_DWELL_MS - 1));
      const c = P.nextPresence(b.state, true, new Date(now + P.ARRIVE_DWELL_MS));
      // Accuracy: a fix whose error circle is bigger than the allowance isn't "near".
      // Accuracy can widen the radius by at most MAX_ACCURACY_ALLOWANCE_M.
      const nearGood = P.isNearVenue(100, 20), nearFuzzy = P.isNearVenue(P.ARRIVE_RADIUS_M + P.MAX_ACCURACY_ALLOWANCE_M + 50, 1000), far = P.isNearVenue(2000, 10);
      // Text arrival vs location arrival, on a Co test event A is on.
      await member("A"); await member("B");
      await testEvent("test-evt-1", "Climate Hardware Night", now - 20 * 60_000, now + 2 * 3600_000, [ID.A]);
      lumaEvents([]);
      const notArrival = await P.arrivedByText(ID.A, "I'm here in SF this week, any events?");
      const byText = await P.arrivedByText(ID.A, "just got here");
      const notTheirs = await P.recordTextArrival(ID.B);
      await settle();
      const pres = await rows(`SELECT user_id, arrived_via FROM event_presence`);
      return {
        checks: [
          ck("fresh fix used; stale fix dropped; revoked not sharing", parsed.fixes.has(PHONE.A) && !parsed.fixes.has(PHONE.B) && parsed.sharing.has(PHONE.B) && !parsed.sharing.has(PHONE.C), { sharing: [...parsed.sharing], fixes: [...parsed.fixes.keys()] }),
          ck(`no arrival before ${P.ARRIVE_DWELL_MS / 60000} minutes near, arrival at it`, a.change === null && b.change === null && c.change === "arrived"),
          ck("a fix whose error is huge can't stretch past radius + allowance; a far fix isn't near", nearGood && !nearFuzzy && !far, { nearGood, nearFuzzy, far }),
          ck("'I'm here in SF this week' isn't an arrival", notArrival === null),
          ck("'just got here' arrives A by text at A's event", byText?.eventApiId === "test-evt-1" && pres.some((p: any) => p.user_id === ID.A && p.arrived_via === "text"), { byText, pres }),
          ck("no invented presence for someone not on the event", notTheirs === null && !pres.some((p: any) => p.user_id === ID.B), { notTheirs, pres }),
        ],
        observed: { note: "co_test_locations fixes bypass the 10-minute age check in fetchSharedLocations (test seam only)." },
      };
    },
  },
  {
    suite: "events", id: "event-nudge-boundary", mode: "model-free", runs1: true,
    run: async () => {
      const C = await import("../../src/harness/introConsent.js");
      const S = await import("../../src/services/eventScoring.js");
      const t0 = Date.parse("2026-10-10T02:00:00Z"), end = t0 + 3 * 3600_000;
      const timing = { start_at: iso(t0), end_at: iso(end) };
      const at = (ms: number) => C.checkEventWindow(timing, new Date(ms)).pass;
      const cutoff = end - C.MATCH_NUDGE_END_CUTOFF_MINUTES * 60_000;
      await member("A"); await member("B");
      await rows(`INSERT INTO event_guest_match_nudges (event_id, person_id, candidate_id, score) VALUES ('evt-n', $1, $2, 80)`, [ID.A, ID.B]);
      const already = await S.wasAlreadyNudgedForMatch("evt-n", ID.A);
      const notYet = await S.wasAlreadyNudgedForMatch("evt-n", ID.B);
      return {
        checks: [
          ck("1ms before start: no nudge", !at(t0 - 1)),
          ck("inside the event: allowed", at(t0 + 60 * 60_000)),
          ck(`exactly end minus ${C.MATCH_NUDGE_END_CUTOFF_MINUTES} minutes: still allowed`, at(cutoff)),
          ck("1ms later: no nudge", !at(cutoff + 1)),
          ck("missing timing passes unless timing is required", C.checkEventWindow(null, new Date()).pass && !C.checkEventWindow(null, new Date(), { requireTiming: true }).pass),
          ck("one nudge per person per event", already && !notYet && !C.checkOneNudgePerEvent(already).pass),
        ],
      };
    },
  },
  {
    suite: "events", id: "event-same-id-overlap",
    run: async () => {
      // A and B were both shown the same event; C was shown a lookalike with a different id; D an opening.
      await member("A", { profile: { intent: intent([{ text: "climate hardware founders", type: "seeking" }]) } });
      await member("B", { profile: { intent: intent([{ text: "battery hardware cofounder", type: "offering" }]) } });
      await member("C");
      const M = await import("../../src/services/eventMatching.js");
      await M.recordSurfacedEventAndMatch(ID.A, "evt-hw", "Climate Hardware Night", "2026-10-10");
      await M.recordSurfacedEventAndMatch(ID.B, "evt-hw", "Climate Hardware Night", "2026-10-10");
      await M.recordSurfacedEventAndMatch(ID.C, "evt-hw-2", "Climate Hardware Night!", "2026-10-10");
      await settle();
      const surfaced = await rows(`SELECT user_id, event_api_id FROM surfaced_events ORDER BY user_id`);
      const canon = M.pickCanonicalEventId([{ user_id: ID.A, event_api_id: "evt-hw", source: "surfaced" }, { user_id: ID.B, event_api_id: "evt-hw", source: "surfaced" }, { user_id: ID.C, event_api_id: "evt-hw-2", source: "surfaced" }], [ID.A, ID.B]);
      const attendees = M.attendeesOnly([{ user_id: ID.A, event_api_id: "evt-hw", source: "surfaced" }, { user_id: ID.B, event_api_id: "evt-hw", source: "surfaced" }]);
      const nudges = await rows(`SELECT count(*)::int AS n FROM outbound_messages`);
      return {
        checks: [
          ck("each surfacing keeps its exact event id", surfaced.length === 3 && surfaced.filter((s: any) => s.event_api_id === "evt-hw").length === 2, surfaced),
          ck("the lookalike stays a different event", canon === "evt-hw", canon),
          ck("being shown an event is not attending it", attendees.length === 0, attendees),
          ck("no nudge says anyone is in the room", nudges[0].n === 0, nudges),
        ],
        observed: { note: "Tier 3 openings carry no event id, so they can't create an event-id overlap (see tiers suite)." },
      };
    },
  },
  {
    suite: "events", id: "event-followup",
    run: async () => {
      await member("A"); await member("B"); await member("C", { first: "Jordan" });
      const F = await import("../../src/services/eventCheckinFollowUp.js");
      const now = Date.now();
      const end = now - 30 * 60_000;
      lumaEvents([{ id: "evt-done", name: "Founders Dinner", start: end - 3 * 3600_000, end }]);
      await F.detectAndScheduleCheckins("evt-done", "Founders Dinner", [{ user_id: ID.A } as any]);
      const first = (await rows(`SELECT send_at FROM event_checkin_followups WHERE user_id = $1`, [ID.A]))[0];
      // Scheduling again (a later pass) must not move it.
      await F.scheduleEventCheckinFollowUp(ID.A, "evt-done", "Founders Dinner", new Date(now + 99 * 3600_000));
      const again = await rows(`SELECT send_at FROM event_checkin_followups WHERE user_id = $1`, [ID.A]);
      // Sent, then their reply is recorded once.
      await rows(`UPDATE event_checkin_followups SET sent_at = NOW() WHERE user_id = $1`, [ID.A]);
      const pending = await F.findPendingEventCheckinFollowUp(ID.A);
      if (pending) await F.recordEventCheckinOutcome(ID.A, pending.id, "evt-done", "named_positive" as any);
      const after = await F.findPendingEventCheckinFollowUp(ID.A);
      // Two guests named Jordan at that event: no silent pick.
      await testEvent("test-evt-j", "Founders Dinner", end - 3 * 3600_000, end, [ID.A, ID.B, ID.C]);
      const E = await import("../../src/services/eventGuestMatchHandoff.js");
      await rows(`INSERT INTO event_checkin_followups (user_id, event_api_id, event_name, send_at) VALUES ($1, 'test-evt-j', 'Founders Dinner', NOW())`, [ID.A]);
      await rows(`INSERT INTO event_walkin_checkins (event_api_id, person_id) VALUES ('test-evt-j', $1), ('test-evt-j', $2)`, [ID.B, ID.C]);
      const named = await E.resolveNamedEventGuest(ID.A, "Jordan");
      return {
        checks: [
          ck("follow-up at event end + 3 hours", !!first && Math.abs(new Date(first.send_at).getTime() - (end + 3 * 3600_000)) < 1000, { first, expected: iso(end + 3 * 3600_000) }),
          ck("rescheduling doesn't move or duplicate it", again.length === 1 && new Date(again[0].send_at).getTime() === new Date(first.send_at).getTime(), again),
          ck("the reply is recorded once, then nothing is pending", !!pending && after === null, { pending, after }),
          ck("two guests named Jordan: asks which, picks no one", "error" in named && /more than one/i.test((named as any).error), named),
        ],
        observed: { note: "resolveNamedEventGuest only looks at their most recent Cue event (event_checkin_followups), not an older one they name." },
      };
    },
  },
];
