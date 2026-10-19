// Model-free checks for the host read at a partner night (services/partnerNightReadout.ts): room-level counts only, the
// readout's floors kept, numbers taken at the close before guests are forgotten, no draft until Royce's copy is in, the
// partner's own host address as the default, and nothing ever sent on its own. No network, no database (stubbed), no model.
//
//   npx tsx evals/partners/hostRead.ts
import { readFileSync } from "fs";

const H = await import("../../src/services/partnerNightReadout.js");
const C = await import("../../src/services/partnerCopy.js");
const S = await import("../../src/services/partnerReadoutSend.js");
const pool = (await import("../../src/db/db.js")).default as any;

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

const STATS = { kind: "partner" as const, eventName: "Demo Night", partnerName: "House of AI", room: 23, arrived: 17, intakeDone: 12, pairs: 2, intros: 0, themes: { "Investors or funding": 6, "Hiring or talent": 4, "Cofounders or partners": 1 } as any, askCount: 11 };
const APPROVED = { host_headline: "{event}, the room", host_room: "{room} came, {arrived} arrived.", host_intros: "Intros: {intros}.", host_themes: "Looking for: {themes}.", host_no_themes: "Too few to show a pattern.", host_too_small: "Too small to read out.", host_note: "Room-level only." };
const saved = { ...C.PARTNER_COPY };
const setCopy = (o: Record<string, string> | null) => Object.assign(C.PARTNER_COPY as any, o ?? saved);

// ---------------------------------------------------------------- the page (pure)
{
  check("copy pending: no readout at all (never member-worded lines for a partner room)", H.describeNight(STATS) === null);
  check("copy: as shipped, every host line waits on Royce", Object.keys(C.PARTNER_COPY).filter((k) => k.startsWith("host_")).every((k) => (C.PARTNER_COPY as any)[k] === C.PENDING));
  setCopy(APPROVED);
  try {
    const d = H.describeNight(STATS)!;
    check("headline from the copy", d.headline === "Demo Night, the room");
    check("headcounts rounded (never a number the host could subtract from a list)", d.lines[0] === "about 25 came, about 15 arrived.");
    check("pairs nobody was asked about yet are not shown as connections (until P4)", !d.lines.some((l) => /pair/i.test(l)));
    const two = H.describeNight({ ...STATS, intros: 2 })!;
    check("a count under 3 is 'a few'", two.lines.includes("Intros: a few."));
    check("a zero line isn't shown", !d.lines.some((l) => l.startsWith("Intros")));
    check("categories under 3 people fold, nothing per person", d.lines.includes("Looking for: investors or funding (6), hiring or talent (4)."));
    const few = H.describeNight({ ...STATS, askCount: 5 })!;
    check("too few asks: no pattern shown", few.lines.includes("Too few to show a pattern."));
    const small = H.describeNight({ ...STATS, room: 4 })!;
    check("a room under the minimum: that one line only", small.lines.length === 1 && small.lines[0] === "Too small to read out.");
    setCopy({ ...APPROVED, host_room: C.PENDING });
    check("one line it needs still pending: no readout", H.describeNight(STATS) === null);
    setCopy(APPROVED);
    check("shown: a partner readout reads its own frozen lines; a Co readout is described as before", S.shownOf({ ...STATS, shown: d } as any).headline === "Demo Night, the room" && /members were registered/.test(S.shownOf({ eventName: "X", registered: 30, arrived: 20, walkins: 0, briefs: 0, nudged: 0, interested: 0, intros: 0, debriefReplies: 0, metSomeone: 0, conversationsTold: 0, followThroughMembers: 0, themes: {}, askCount: 0 }).lines[0]));
  } finally {
    setCopy(null);
  }
}

// ---------------------------------------------------------------- the snapshot, at close (stubbed)
const realQuery = pool.query;
const NIGHT = { api_id: "partner-aa", partner_id: "p1", name: "Demo Night", start_at: "2026-11-07T02:00:00Z", end_at: "2026-11-07T06:00:00Z", timezone: null, venue: null, address: null, code: "K7Q2MX", intake_opened_at: new Date(), closed_at: new Date(), id: "p1", slug: "hai", partner_name: "House of AI", rsvp_blurb: "{link}", host_name: "Ellis", host_email: "host@example.com", rsvp_blurb_approved_by: "Royce", ended_at: null };
const writes: { q: string; p: any[] }[] = [];
let statsRow: any = null;
let readoutRow: any = null;
let draftsDue = false;
pool.query = async (q: string, p: any[] = []) => {
  if (/FROM partner_events e JOIN partners p/.test(q)) return { rows: [NIGHT] };
  if (/COUNT\(\*\)::int AS n FROM partner_guests WHERE event_api_id = \$1 AND arrived_at/.test(q)) return { rows: [{ n: 14 }] };
  if (/COUNT\(\*\)::int AS n FROM partner_guests WHERE event_api_id = \$1 AND intake_done_at/.test(q)) return { rows: [{ n: 12 }] };
  if (/COUNT\(\*\)::int AS n FROM partner_guests WHERE event_api_id = \$1`?$/.test(q.trim()) || /FROM partner_guests WHERE event_api_id = \$1$/.test(q)) return { rows: [{ n: 20 }] };
  if (/COUNT\(DISTINCT w\.person_id\)[\s\S]*JOIN event_presence/.test(q)) return { rows: [{ n: 3 }] };
  if (/COUNT\(DISTINCT w\.person_id\)/.test(q)) return { rows: [{ n: 4 }] };
  if (/value_verdict = 'strong'/.test(q)) return { rows: [{ n: 5 }] };
  if (/both_yes_at IS NOT NULL/.test(q)) return { rows: [{ n: 0 }] };
  if (/SELECT hoping FROM partner_guests/.test(q)) return { rows: Array.from({ length: 7 }, (_, i) => ({ hoping: i < 4 ? "seed investors for hardware" : "a technical cofounder" })) };
  if (/SELECT cp\.intent FROM event_walkin_checkins/.test(q)) return { rows: [{ intent: [{ text: "angel investors", type: "seeking", status: "active" }] }] };
  if (/INSERT INTO partner_night_stats/.test(q)) {
    writes.push({ q, p });
    statsRow ??= JSON.parse(p[1]);
    return { rows: [] };
  }
  if (/SELECT stats FROM partner_night_stats/.test(q)) return { rows: statsRow ? [{ stats: statsRow }] : [] };
  if (/SELECT \* FROM partner_readouts WHERE event_id/.test(q)) return { rows: readoutRow ? [readoutRow] : [] };
  if (/INSERT INTO partner_readouts/.test(q)) {
    writes.push({ q, p });
    readoutRow = { event_id: p[0], stats: JSON.parse(p[2]), text: p[3], status: "draft" };
    return { rows: [{ id: "r1" }] };
  }
  if (/UPDATE partner_readouts SET status = 'approved'/.test(q)) {
    writes.push({ q, p });
    return { rows: [{ id: "r1" }] };
  }
  if (/FROM users$/.test(q.trim()) || /SELECT first_name, last_name FROM users/.test(q)) return { rows: [{ first_name: "Jordan", last_name: "Lee" }] };
  if (/INSERT INTO harness_decisions/.test(q)) {
    writes.push({ q, p });
    return { rows: [] };
  }
  if (/SELECT e\.api_id, e\.name, e\.start_at, e\.end_at FROM partner_events e JOIN partner_night_stats/.test(q)) return { rows: draftsDue ? [{ api_id: "partner-aa", name: "Demo Night", start_at: "2026-11-07T02:00:00Z", end_at: "2026-11-07T06:00:00Z" }] : [] };
  return { rows: [] };
};
try {
  const classified: string[] = [];
  const s = (await H.snapshotNight("partner-aa", { classify: async (a: string) => (classified.push(a), /investor/.test(a) ? "Investors or funding" : "Cofounders or partners") }))!;
  check("snapshot: guests and members together, arrived by the door", s.room === 24 && s.arrived === 17 && s.intakeDone === 12);
  check("snapshot: pairs judged worth an intro, intros made", s.pairs === 5 && s.intros === 0);
  check("snapshot: what the room was looking for, in fixed categories", s.themes["Investors or funding"] === 5 && s.themes["Cofounders or partners"] === 3 && s.askCount === 8 && classified.length === 8);
  const stored = writes.find((w) => /INSERT INTO partner_night_stats/.test(w.q))!.p[1];
  check("snapshot: no words kept (no ask, no name), counts only", !/seed investors|cofounder|angel|Jordan|Ellis/i.test(stored.replace(/"Cofounders or partners"|"Investors or funding"/g, "")));

  let r = await H.draftNightReadout("partner-aa", { names: async () => ["Jordan"] });
  check("draft: copy pending -> no draft stored", r.status === "copy_pending" && !writes.some((w) => /INSERT INTO partner_readouts/.test(w.q)));
  setCopy(APPROVED);
  r = await H.draftNightReadout("partner-aa", { names: async () => ["Jordan"] });
  check("draft: copy approved -> drafted into the readout table, with its own frozen lines", r.status === "drafted" && readoutRow?.stats?.kind === "partner" && readoutRow?.stats?.shown?.headline === "Demo Night, the room");
  check("draft: once (a second run finds it)", (await H.draftNightReadout("partner-aa")).status === "exists");
  readoutRow = null;
  setCopy({ ...APPROVED, host_note: "Thanks to Ellis and the team" });
  r = await H.draftNightReadout("partner-aa", { names: async () => ["Ellis"] });
  check("draft: a page carrying a member's name stores nothing", r.status === "leak" && readoutRow === null);
  // A name right before a period (review of #217: the fold kept the ".", so "Thanks, Ellis." passed the name check).
  setCopy({ ...APPROVED, host_note: "Thanks, Ellis." });
  r = await H.draftNightReadout("partner-aa", { names: async () => ["Ellis"] });
  check("draft: a member's name right before a period stores nothing", r.status === "leak" && readoutRow === null);
  check("leak check: a name before a period, a comma or the end is caught; an email address still reads as one", !!S.readoutLeak("Thanks, Ellis.", "", ["Ellis"]) && !!S.readoutLeak("Thanks Ellis, and team", "", ["Ellis"]) && !!S.readoutLeak("With thanks to Ellis", "", ["Ellis"]) && S.readoutLeak("Write to host.team@example.com.", "", []) === "an email address" && S.readoutLeak("Thanks, everyone.", "", ["Ellis"]) === null);
  setCopy(APPROVED);
  statsRow = { ...statsRow, room: 3 };
  r = await H.draftNightReadout("partner-aa", { names: async () => [] });
  check("draft: a room under the minimum gets no readout", r.status === "too_small" && readoutRow === null);
  statsRow = null;
  check("draft: no snapshot, no draft", (await H.draftNightReadout("partner-aa")).status === "no_snapshot");

  // The close itself: the numbers are taken before the guests are forgotten (the order, run for real on the stubbed pool).
  {
    const order: string[] = [];
    const q0 = pool.query;
    const c0 = pool.connect;
    statsRow = null;
    const closeFake = async (q: string, p: any[] = []) => {
      if (/SELECT DISTINCT e\.api_id/.test(q)) return { rows: [{ api_id: "partner-aa", start_at: "2026-11-07T02:00:00Z", end_at: "2026-11-07T06:00:00Z", timezone: null, closed_at: null }] };
      if (/INSERT INTO partner_night_stats/.test(q)) order.push("snapshot");
      if (/SET resolved_at = \$2, resolution = 'forgotten'/.test(q)) {
        order.push("forget");
        return { rows: [{ id: p[0] }] };
      }
      if (/SELECT g\.id, g\.user_id, coalesce/.test(q)) return { rows: [{ id: "g1", user_id: "u-guest", member: false }] };
      // No asks here, so no classifier call: this test is about order only.
      if (/SELECT hoping FROM partner_guests|SELECT cp\.intent FROM event_walkin_checkins/.test(q)) return { rows: [] };
      return q0(q, p);
    };
    pool.query = closeFake;
    pool.connect = async () => ({ query: closeFake, release: () => {} });
    const G = await import("../../src/services/partnerGuests.js");
    await G.runPartnerNightCloses(new Date("2026-11-07T07:00:00Z"));
    pool.query = q0;
    pool.connect = c0;
    check("close: the snapshot is taken, and before the guests are forgotten", order.join() === "snapshot,forget");
  }

  // The hourly drafts job: a draft is a decision-log entry and a log line, never an email (Royce: no new emails).
  {
    statsRow = { ...STATS };
    readoutRow = null;
    setCopy(APPROVED);
    draftsDue = true;
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (u: unknown) => (fetched.push(String(u)), new Response("{}", { status: 200 }));
    const n = await H.runNightReadoutDrafts(new Date("2026-11-07T20:00:00Z"), { names: async () => [] });
    (globalThis as any).fetch = realFetch;
    draftsDue = false;
    const logged = writes.filter((w) => /INSERT INTO harness_decisions/.test(w.q) && w.p.includes("partner.hostReadDrafted"));
    check("drafts job: a draft is recorded in the decision log (counts no words: the event id only)", n === 1 && logged.length === 1 && !JSON.stringify(logged[0].p).includes("Demo Night"), { n, logged: logged.map((w) => w.p) });
    check("drafts job: no email, nothing sent anywhere", fetched.length === 0, fetched);
    readoutRow = null;
  }

  // Approval: the partner's own host address by default; never an email on its own.
  const savedUrl = process.env.API_URL;
  process.env.API_URL = "https://api.example.com";
  const a = await H.approveNightReadout("partner-aa", "Royce");
  const upd = writes.find((w) => /UPDATE partner_readouts SET status = 'approved'/.test(w.q));
  check("approve: the partner's host address is the default", a.ok && upd?.p[2] === "host@example.com");
  if (savedUrl === undefined) delete process.env.API_URL;
  else process.env.API_URL = savedUrl;
} finally {
  setCopy(null);
  pool.query = realQuery;
}

// ---------------------------------------------------------------- wiring
{
  const guests = src("src/services/partnerGuests.ts");
  const close = guests.slice(guests.indexOf("export async function runPartnerNightCloses"), guests.indexOf("export async function resolveGuests"));
  check("close: the numbers are taken before guests are forgotten", close.indexOf("snapshotNight(r.api_id)") > 0 && close.indexOf("snapshotNight(r.api_id)") < close.indexOf("resolveGuests(r.api_id"));
  check("close: a failed snapshot never holds the forgetting", /snapshotNight\(r\.api_id\)\.catch\(/.test(close));
  const svc = src("src/services/partnerNightReadout.ts").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  check("never sends to a host: drafts only (no email or text path)", !/sendReadout|resend|sendblue|deps\.email/i.test(svc));
  check("no team email for a draft (Royce: no new emails)", !/reportEmail|sendReportEmail|notify\(/.test(svc));
  check("the readout's floors are the readout's (cell, approx, foldThemes, READOUT)", /approx\(s\.room\)/.test(svc) && /cell\(s\.intros\)/.test(svc) && /foldThemes\(s\.themes\)/.test(svc) && /s\.room < READOUT\.minRoom/.test(svc));
  check("the leak check runs before anything is stored", svc.indexOf("readoutLeak(text") > 0 && svc.indexOf("readoutLeak(text") < svc.indexOf("INSERT INTO partner_readouts"));
  const send = src("src/services/partnerReadoutSend.ts");
  check("the host's link and email read the frozen lines (shownOf)", /\.\.\.shownOf\(r\.stats\)/.test(send) && /shownOf\(r\.stats\)\.headline/.test(send));
  check("job: hourly with the readout drafts", /runNightReadoutDrafts\(\)/.test(src("src/jobs/index.ts")));
  check("table: counts only, one per night", /CREATE TABLE IF NOT EXISTS partner_night_stats \(event_api_id TEXT PRIMARY KEY/.test(src("src/db/migrations.ts")));
}

console.log(`partner host read: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
