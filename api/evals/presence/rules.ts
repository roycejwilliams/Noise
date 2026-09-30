// Model-free checks for event arrival (services/eventPresence.ts): the
// arrive/leave rules, "I'm here", the day-of ask, the nudge hold, and that
// no coordinates are ever stored. No network.
//
//   npx tsx evals/presence/rules.ts
import { readFileSync } from "fs";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const P = await import("../../src/services/eventPresence.js");
const { cleanCoMessage } = await import("../../src/services/sendblue.js");

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const t0 = new Date("2026-09-24T02:00:00Z"); // 7pm PT
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

// ---------------------------------------------------------------- distance
const venue = { lat: 37.7793, lng: -122.4193 };
const blockAway = { lat: 37.7811, lng: -122.4193 }; // ~200m north
check("distance: about 200m for a block and a bit", Math.abs(P.distanceMeters(venue, blockAway) - 200) < 10);
check("near: inside 150m", P.isNearVenue(120, 10));
check("near: a fuzzy fix gets some slack", P.isNearVenue(200, 80) && !P.isNearVenue(200, 20));
check("near: slack is capped, a very fuzzy fix can't count from far away", !P.isNearVenue(400, 1000));

// ---------------------------------------------------------------- arrive / leave
let s: any = { near_since: null, arrived_at: null, away_since: null, left_at: null };
let r = P.nextPresence(s, true, at(0));
check("arrive: first near fix only starts the clock", r.change === null && r.state.near_since?.getTime() === at(0).getTime());
r = P.nextPresence(r.state, true, at(2));
check("arrive: 2 minutes isn't enough (walking past)", r.change === null);
r = P.nextPresence(r.state, true, at(4));
check("arrive: 4 minutes near counts as arrived", r.change === "arrived" && r.state.arrived_at?.getTime() === at(4).getTime());
{
  const passing = P.nextPresence(P.nextPresence(s, true, at(0)).state, false, at(2));
  check("arrive: stepping away resets the clock", passing.state.near_since === null);
}
let l = P.nextPresence(r.state, false, at(10));
check("leave: first away fix only starts the clock", l.change === null && l.state.away_since !== null);
l = P.nextPresence(l.state, true, at(12));
check("leave: coming back (smoke break) clears it", l.state.away_since === null);
l = P.nextPresence(P.nextPresence(l.state, false, at(20)).state, false, at(36));
check("leave: 15+ minutes away counts as left", l.change === "left");
check("leave: nothing changes after they've left", P.nextPresence(l.state, true, at(40)).change === null);

// ---------------------------------------------------------------- "I'm here"
for (const yes of ["I'm here", "im here!", "Here", "here!", "just got here", "just arrived", "made it", "ok I'm here", "I'm at the event"]) {
  check(`I'm here: "${yes}" counts`, P.isImHere(yes));
}
for (const no of ["I'm here in SF this week, anything good?", "I'm here for it", "where are you", "not here yet, 10 min", "hear me out"]) {
  check(`I'm here: "${no}" doesn't`, !P.isImHere(no));
}

// ---------------------------------------------------------------- the day-of ask
const ev = { name: "Founders Supper", start_at: "2026-09-24T02:00:00Z", timezone: "America/Los_Angeles", venue: "The Battery" };
check("ask: not before 10am local", !P.askWindowOpen(ev, new Date("2026-09-23T16:30:00Z"))); // 9:30am PT
check("ask: from 10am on the day", P.askWindowOpen(ev, new Date("2026-09-23T17:05:00Z")));
check("ask: not in the last 30 minutes before the start", !P.askWindowOpen(ev, new Date("2026-09-24T01:40:00Z")));
check("ask: not the day before", !P.askWindowOpen(ev, new Date("2026-09-22T20:00:00Z")));
const ask = P.arrivalAskText(ev, true);
check("ask: names the night, the event and the place", ask.startsWith("Tonight: Founders Supper at The Battery."));
check("ask: offers both ways, location or 'I'm here'", /share your location with me until the end of the day/.test(ask) && /"I'm here"/.test(ask));
check("ask: no location offer when the venue has no coordinates", !/location/.test(P.arrivalAskText(ev, false)) && /"I'm here"/.test(P.arrivalAskText(ev, false)));
check("ask: survives Co's send cleanup and has no em dashes", cleanCoMessage(ask) === ask && !/[—–]/.test(ask));
check("ask: a daytime event says Today", P.arrivalAskText({ ...ev, start_at: "2026-09-23T19:00:00Z" }, true).startsWith("Today:"));

// ---------------------------------------------------------------- the nudge hold
const start = "2026-09-24T02:00:00Z";
check("hold: not sharing, nudge at the start as before", P.arrivalWaitCheck(null, start, at(5)).pass);
check("hold: sharing and not here yet, wait", !P.arrivalWaitCheck({ sharing_seen_at: at(-60), arrived_at: null }, start, at(5)).pass);
check("hold: arrived, send", P.arrivalWaitCheck({ sharing_seen_at: at(-60), arrived_at: at(3) }, start, at(5)).pass);
check("hold: an hour in and still not here, send anyway", P.arrivalWaitCheck({ sharing_seen_at: at(-60), arrived_at: null }, start, at(61)).pass);

// ---------------------------------------------------------------- reading Sendblue
{
  const now = new Date("2026-09-24T02:10:00Z");
  const fix = (state: string, ts: string, extra: any = {}) => ({ number: `+1${Math.random().toString().slice(2, 12)}`, state, location: { latitude: 37.78, longitude: -122.42, accuracy: 20, timestamp: ts, ...extra } });
  const rows = [fix("shared_with_fix", "2026-09-24T02:08:00Z"), fix("shared_with_fix", "2026-09-24T01:30:00Z"), fix("shared_no_fix_yet", "2026-09-24T02:08:00Z"), fix("not_shared", "2026-09-24T02:08:00Z"), fix("shared_with_fix", "2026-09-24T02:08:00Z", { expiresAt: "2026-09-24T02:00:00Z" })];
  const parsed = P.parseSharedLocations({ locations: rows }, now);
  check("sendblue: a fresh fix is used", parsed.fixes.has(rows[0].number));
  check("sendblue: a stale fix isn't", !parsed.fixes.has(rows[1].number));
  check("sendblue: sharing without a fix still counts as sharing (so the nudge waits)", parsed.sharing.has(rows[2].number) && !parsed.fixes.has(rows[2].number));
  check("sendblue: not_shared is ignored entirely", !parsed.sharing.has(rows[3].number));
  check("sendblue: an expired share isn't used", !parsed.fixes.has(rows[4].number));
  check("sendblue: junk doesn't throw", P.parseSharedLocations(null, now).fixes.size === 0);
}

// ---------------------------------------------------------------- wiring and privacy
const m = src("src/db/migrations.ts");
const table = m.slice(m.indexOf("CREATE TABLE IF NOT EXISTS event_presence"), m.indexOf("event_presence table init failed"));
check("privacy: event_presence stores times, never coordinates", table.length > 0 && !/lat|lng|longitude|latitude|coord|address/i.test(table));
const svc = src("src/services/eventPresence.ts");
check("privacy: no coordinates in any logged decision", !/proposal: \{[^}]*(lat|lng|fix|distance)/.test(svc));
check("only approved, reachable members are asked", /approval_status === "approved"/.test(svc) && /sms_opted_out, false\) = false AND u\.archived_at IS NULL/.test(svc));
check("each member gets one pre-arrival text per event (its own target key, and not after it went out)", /targetKey: `pre_arrival:\$\{event\.api_id\}`/.test(svc) && /alreadySent: !!row\?\.pre_arrival_sent_at/.test(svc));
check("the pre-arrival text goes through the daily pick (the send ledger and caps), not the in-room count", /type: "pre_arrival",/.test(svc) && !/recordInRoomSend\(m\.user_id, `arrival_ask/.test(svc));
check("leaving early moves the end-of-night check-in up", /UPDATE event_checkin_followups SET send_at = LEAST\(send_at, NOW\(\) \+ INTERVAL '30 minutes'\)/.test(svc));
const sc = src("src/services/eventScoring.ts");
check("the in-room nudge waits for arrival", /arrivalWaitCheck\(await getPresence\(eventId, person\.user_id\), eventTiming\.start_at, new Date\(\)\)/.test(sc));
const sb = src("src/routes/sendblue.ts");
// Arrival is Co's call now (conversationTools.ts markArrived, 2026-09-25):
// members only (the reply agent only runs for members), and it re-scores.
check("saying they've arrived marks arrival and re-scores", /markArrived: tool\(\{[\s\S]{0,900}recordTextArrival\(ctx\.userId\)[\s\S]{0,400}arrived\.isNew[\s\S]{0,80}scoreGuestListForEvent/.test(src("src/agent/conversationTools.ts")));
check("no Co event on: nothing recorded, and Co doesn't welcome them", /no Co event of theirs on right now/.test(src("src/agent/conversationTools.ts")));
check("the reply welcomes them without naming anyone", /don't name anyone or promise a person here/.test(src("src/agent/conversationTools.ts")));
{
  const geo = src("src/services/geocoding.ts");
  const fn = geo.slice(geo.indexOf("export async function geocodeVenue"), geo.indexOf("// Open-Meteo"));
  check("venue lookup: street-level or nothing, never a city's center", fn.length > 0 && !/openMeteo/.test(fn) && /VENUE_PRECISE\.has/.test(fn) && /new Set\(\["ROOFTOP", "RANGE_INTERPOLATED"\]\)/.test(geo) && /if \(!hit \|\| !precise\) return null;/.test(fn));
  check("venue: Luma's coordinates first, then the address, else 'I'm here' only", /const canUseLocation = \(await venueFor\(event\)\) !== null;/.test(svc) && /const venue = await venueFor\(event\);/.test(svc));
}
const jobs = src("src/jobs/index.ts");
check("jobs: the ask every 15 minutes, the poll every 2, never overlapping", /runArrivalAsks\(\)/.test(jobs) && /cron\.schedule\("\*\/2 \* \* \* \*"/.test(jobs) && /if \(presenceRunning\) return;/.test(jobs));

console.log(`presence rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
