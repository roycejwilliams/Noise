// Model-free checks for partner guests (services/partnerGuests.ts): guest-first entry (the code text is consent, intake and
// arrival), the light intake (each question once, nothing asked twice, their words only), the cutoff (no proactive contact
// after a guest's night closes, on every send path), forget by default at close, and that no guest-facing word ships without
// Royce's copy. No network, no database (the pool is stubbed), no model (the intake read is stubbed).
//
//   npx tsx evals/partners/guests.ts
import { readFileSync } from "fs";

const G = await import("../../src/services/partnerGuests.js");
const C = await import("../../src/services/partnerCopy.js");
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

const NIGHT = { api_id: "partner-aa", partner_id: "p1", name: "Demo Night", start_at: "2026-11-07T02:00:00.000Z", end_at: "2026-11-07T06:00:00.000Z", timezone: "America/Los_Angeles", venue: null, address: null, code: "K7Q2MX", intake_opened_at: new Date("2026-11-01T00:00:00Z"), closed_at: null as Date | null };
const PARTNER = { id: "p1", slug: "hai", name: "House of AI", rsvp_blurb: "{link}", host_name: null, host_email: null, rsvp_blurb_approved_by: "Royce", ended_at: null };
const before = new Date("2026-11-03T18:00:00Z"); // RSVP days before
const during = new Date("2026-11-07T03:00:00Z");
const afterClose = new Date("2026-11-07T06:20:00Z");
const blank = { who: null, work: null, hoping: null, asked_who_at: null, asked_work_at: null, asked_hoping_at: null } as any;
const t = (iso: string) => new Date(iso);

// ---------------------------------------------------------------- rules (pure)
{
  check("close: the night's end plus the room-close buffer", G.nightClosesAt(NIGHT).toISOString() === "2026-11-07T06:15:00.000Z");
  check("close: closed early by hand wins", G.nightClosesAt({ ...NIGHT, closed_at: t("2026-11-07T04:00:00Z") }).toISOString() === "2026-11-07T04:00:00.000Z");
  check("close: no end on file -> the evening's end (effectiveEnd), plus the buffer", G.nightClosesAt({ ...NIGHT, end_at: null }).getTime() > t("2026-11-07T06:15:00Z").getTime());
  check("live: before close and unresolved", G.guestLive({ resolved_at: null }, NIGHT, during) && !G.guestLive({ resolved_at: null }, NIGHT, afterClose) && !G.guestLive({ resolved_at: during }, NIGHT, during));
}
{
  check("intake: the first question is who they are", G.nextQuestion(blank) === "who");
  check("intake: answered in passing -> skipped", G.nextQuestion({ ...blank, who: "Jordan", work: "design studio" }) === "hoping");
  check("intake: asked and never answered -> never asked again", G.nextQuestion({ ...blank, asked_who_at: before }) === "work");
  check("intake: all asked -> nothing more to ask", G.nextQuestion({ ...blank, asked_who_at: before, asked_work_at: before, asked_hoping_at: before }) === null);
  check("intake: the open question is the last one asked and unanswered", G.openQuestion({ ...blank, who: "Jordan", asked_who_at: t("2026-11-07T02:00:00Z"), asked_work_at: t("2026-11-07T02:01:00Z") }) === "work");
  check("intake: nothing open once it's answered", G.openQuestion({ ...blank, who: "Jordan", asked_who_at: before }) === null);
}
{
  check("their words: a name they gave is grounded", G.grounded("Jordan", "hey I'm Jordan!"));
  check("their words: an invented word isn't", !G.grounded("Jordan Lee", "hey I'm Jordan"));
  check("their words: an empty value isn't", !G.grounded("  ", "anything"));
  const asked = { ...blank, asked_who_at: before };
  check("answer: the open question gets their whole text when the read found nothing", G.applyAnswer(asked, "Jordan, I run a studio", {}).who === "Jordan, I run a studio");
  const both = G.applyAnswer(asked, "I'm Jordan and I run a design studio", { who: "Jordan", work: "run a design studio", hoping: "investors" });
  check("answer: one text answers two questions (nothing asked twice), ungrounded dropped", both.who === "Jordan" && both.work === "run a design studio" && both.hoping === undefined);
  check("answer: a field already filled is never overwritten", G.applyAnswer({ ...asked, who: "Noor" }, "Jordan", { who: "Jordan" }).who === undefined);
  check("answer: capped", (G.applyAnswer({ ...blank, asked_hoping_at: before }, "x ".repeat(400), {}).hoping ?? "").length <= G.GUESTS.maxAnswer);
}
{
  const nightRow = (o: any = {}) => ({ resolved_at: null, closes_at: t("2026-11-07T06:15:00Z"), ...o });
  check("cutoff: a member passes", G.cutoffCheck({ member: true, guestNights: [nightRow({ resolved_at: during })] }, afterClose).pass);
  check("cutoff: a non-member who was never a guest isn't decided here", G.cutoffCheck({ member: false, guestNights: [] }, afterClose).pass);
  check("cutoff: a guest during their night passes", G.cutoffCheck({ member: false, guestNights: [nightRow()] }, during).pass);
  check("cutoff: a guest after their night closed is held", !G.cutoffCheck({ member: false, guestNights: [nightRow()] }, afterClose).pass);
  check("cutoff: a resolved guest is held even before the close time", !G.cutoffCheck({ member: false, guestNights: [nightRow({ resolved_at: during })] }, during).pass);
  check("cutoff: one live night among old ones passes", G.cutoffCheck({ member: false, guestNights: [nightRow({ resolved_at: before }), nightRow()] }, during).pass);
}

// ---------------------------------------------------------------- the inbound text (stubbed pool and deps)
type Row = any;
const realQuery = pool.query;
const realConnect = pool.connect;
let guests: Row[] = [];
let linesRecent = 0;
const decisions: any[] = [];
const sql: { q: string; p: any[] }[] = [];
let nextId = 1;
const fake = async (q: string, p: any[] = []) => {
  sql.push({ q, p });
  if (/INSERT INTO harness_decisions/.test(q)) {
    decisions.push({ decision: p[1], action: p[4], outcome: p[3], proposal: p[5] });
    return { rows: [] };
  }
  if (/FROM harness_decisions/.test(q)) return { rows: [{ n: linesRecent }] };
  if (/FROM invite_codes WHERE code = ANY/.test(q)) return { rows: (p[0] as string[]).includes("6VGF76VK") ? [{ x: 1 }] : [] };
  if (/INSERT INTO partner_guests/.test(q)) {
    const have = guests.find((g) => g.event_api_id === p[0] && g.user_id === p[1]);
    if (have) {
      if (have.resolved_at) return { rows: [] };
      have.arrived_at ??= p[3];
      return { rows: [{ ...have, fresh: false }] };
    }
    const g = { id: String(nextId++), event_api_id: p[0], user_id: p[1], entered_at: p[2], arrived_at: p[3], ...blank, intake_done_at: null, resolved_at: null, resolution: null };
    guests.push(g);
    return { rows: [{ ...g, fresh: true }] };
  }
  if (/UPDATE partner_guests SET who = COALESCE/.test(q)) {
    const g = guests.find((x) => x.id === p[0]);
    g.who ??= p[1];
    g.work ??= p[2];
    g.hoping ??= p[3];
    return { rows: [g] };
  }
  const asked = q.match(/UPDATE partner_guests SET (asked_\w+_at|intake_done_at) = NOW\(\)/);
  if (asked) {
    const g = guests.find((x) => x.id === p[0]);
    g[asked[1]] ??= new Date();
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE partner_guests SET arrived_at/.test(q)) {
    const g = guests.find((x) => x.id === p[0]);
    g.arrived_at ??= p[1];
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};

function harness(o: { found?: any; copy?: Record<string, string>; read?: any } = {}) {
  const sent: string[] = [];
  const logged: string[] = [];
  const deps = {
    resolve: async (text: string) => (/K7Q2MX/i.test(text) ? (o.found ?? { event: NIGHT, partner: PARTNER }) : null),
    rows: async (userId: string) => guests.filter((g) => g.user_id === userId).map((g) => ({ ...g, event: NIGHT, partner: PARTNER })),
    read: o.read ?? (async () => ({})),
    send: async (line: string) => {
      sent.push(line);
      return true;
    },
    log: async (line: string) => {
      logged.push(line);
    },
    isImHere: (x: string) => /^i'?m here$/i.test(x.trim()),
  };
  return { deps, sent, logged };
}
const APPROVED = {
  guest_ask_who: "Q who",
  guest_ask_work: "Q work",
  guest_ask_hoping: "Q hoping",
  guest_intake_done: "done {event}",
  guest_arrived: "arrived",
  guest_during_night: "during",
  guest_not_open: "not open {event}",
  guest_late_next: "over; next {next} {link}",
  guest_late: "over {event}",
  guest_after_cutoff: "club line",
};
const saved = { ...C.PARTNER_COPY };
const setCopy = (on: boolean) => Object.assign(C.PARTNER_COPY as any, on ? APPROVED : saved);
const guest = { id: "u-guest", invite_verified: false };
const member = { id: "u-member", invite_verified: true };

pool.query = fake;
pool.connect = async () => ({ query: fake, release: () => {} });
try {
  // Members are never guests.
  {
    const h = harness();
    const at = await G.handlePartnerText(member, "Hi Cue (K7Q2MX)", { ...h.deps, now: during });
    check("member: a live code at the door -> the walk-in check-in, not a guest", at.handled === false && (at as any).memberCheckin?.eventApiId === "partner-aa" && guests.length === 0);
    const early = await G.handlePartnerText(member, "Hi Cue (K7Q2MX)", { ...h.deps, now: before });
    check("member: the RSVP link days before -> just their normal reply", early.handled === false && !(early as any).memberCheckin);
    const plain = await G.handlePartnerText(member, "what's on this week", { ...h.deps, now: during });
    check("member: no code -> untouched", plain.handled === false && h.sent.length === 0);
  }
  // Non-members who aren't guests go to the invite gate; bots are never answered.
  {
    const h = harness();
    check("non-member, no code, never a guest -> the invite gate", (await G.handlePartnerText(guest, "hey", { ...h.deps, now: during })).handled === false);
    check("an automated sender is never answered or entered", (await G.handlePartnerText(guest, "Reply STOP to unsubscribe (K7Q2MX)", { ...h.deps, now: during })).handled === false && guests.length === 0);
  }
  // Copy pending: the guest is entered (their text is their consent), but nothing is sent and no question counts as asked.
  {
    const h = harness();
    const r = await G.handlePartnerText(guest, "Hi Cue, it's for Demo Night (K7Q2MX)", { ...h.deps, now: before });
    const g = guests[0];
    check("entry: the code text makes their guest row for that night", r.handled === true && g?.event_api_id === "partner-aa" && g?.user_id === "u-guest");
    check("entry: from the RSVP link days before, not yet arrived", g?.arrived_at === null);
    check("copy pending: nothing is sent to the guest", h.sent.length === 0);
    check("copy pending: the question isn't counted as asked", g?.asked_who_at === null);
    check("copy pending: logged as skipped, with no message content", decisions.some((d) => d.action === "ask_who" && d.outcome === "skip") && !decisions.some((d) => /Demo Night \(K7Q2MX\)|Hi Cue/.test(String(d.proposal ?? ""))));
    check("entry: their text is logged to their conversation (deleted at close)", h.logged.length === 1);
  }
  // Copy approved (simulated here only): the intake runs.
  setCopy(true);
  {
    const h = harness({ read: async (text: string) => (/design/.test(text) ? { who: "Jordan", work: "run a design studio" } : {}) });
    await G.handlePartnerText(guest, "Hi Cue, it's for Demo Night (K7Q2MX)", { ...h.deps, now: before });
    const g = guests[0];
    check("intake: the first question goes out and is counted", h.sent[0] === "Q who" && g.asked_who_at instanceof Date);
    await G.handlePartnerText(guest, "I'm Jordan and I run a design studio", { ...h.deps, now: before });
    check("intake: one text answers two questions; the work question is skipped", g.who === "Jordan" && g.work === "run a design studio" && h.sent[1] === "Q hoping" && g.asked_work_at === null);
    await G.handlePartnerText(guest, "investors who get hardware", { ...h.deps, now: before });
    check("intake: the last answer, then done once", g.hoping === "investors who get hardware" && h.sent[2] === "done Demo Night" && g.intake_done_at instanceof Date);
    check("intake: never asked twice", h.sent.filter((s) => s.startsWith("Q ")).length === 2);
    // The door on the night: arrival, one line, nothing asked.
    await G.handlePartnerText(guest, "Hi Cue, it's for Demo Night (K7Q2MX)", { ...h.deps, now: during });
    check("door: an RSVP guest scanning in arrives, gets one line, is asked nothing", g.arrived_at?.getTime() === during.getTime() && h.sent[3] === "arrived" && h.sent.length === 4);
    // Texts during the night after intake: the during-night line, at most every few hours.
    linesRecent = 0;
    await G.handlePartnerText(guest, "where's the bar", { ...h.deps, now: during });
    linesRecent = 1;
    await G.handlePartnerText(guest, "hello?", { ...h.deps, now: during });
    check("during the night: one line, then quiet for a few hours", h.sent[4] === "during" && h.sent.length === 5);
    linesRecent = 0;
    check("an ordinary eight-letter word is an answer, not an invite code", h.sent.length === 5 && g.hoping === "investors who get hardware");
    check("an invite code mid-night goes to the invite gate (a guest can join any time)", (await G.handlePartnerText(guest, "my friend gave me 6VGF76VK", { ...h.deps, now: during })).handled === false);
    check("only an unused code counts", /FROM invite_codes WHERE code = ANY\(\$1::text\[\]\) AND used_by IS NULL/.test(sql.filter((c) => /invite_codes/.test(c.q)).pop()?.q ?? ""));
    // After the cutoff: no work, one warm line a day, nothing logged.
    const logs = h.logged.length;
    const late = await G.handlePartnerText(guest, "hey can you find me a dinner spot", { ...h.deps, now: afterClose });
    check("after the cutoff: the one line, and Cue doesn't work for them", late.handled === true && h.sent[5] === "club line" && h.sent.length === 6);
    check("after the cutoff: their text isn't logged", h.logged.length === logs);
    linesRecent = 1;
    await G.handlePartnerText(guest, "hello?", { ...h.deps, now: afterClose });
    check("after the cutoff: at most once a day", h.sent.length === 6);
    linesRecent = 0;
  }
  // "I'm here" on the night is arrival.
  {
    guests = [];
    const h = harness();
    await G.handlePartnerText(guest, "Hi Cue (K7Q2MX)", { ...h.deps, now: before });
    await G.handlePartnerText(guest, "Jordan", { ...h.deps, now: before });
    await G.handlePartnerText(guest, "I'm here", { ...h.deps, now: during });
    check("arrival: \"I'm here\" during the check-in window", guests[0].arrived_at?.getTime() === during.getTime());
    const up = sql.filter((c) => /INSERT INTO partner_guests/.test(c.q)).pop();
    check("arrival: a later scan never moves the first arrival", !!up && /arrived_at = COALESCE\(partner_guests\.arrived_at, EXCLUDED\.arrived_at\)/.test(up.q));
  }
  // A photo while a question is open: nothing new is asked over it.
  {
    guests = [];
    const h = harness();
    await G.handlePartnerText(guest, "Hi Cue (K7Q2MX)", { ...h.deps, now: before });
    const n = h.sent.length;
    await G.handlePartnerText(guest, null, { ...h.deps, now: before });
    check("intake: a photo while a question is open -> nothing new asked", h.sent.length === n && guests[0].asked_work_at === null);
  }
  // A code that isn't live.
  {
    guests = [];
    const h = harness({ found: { event: { ...NIGHT, intake_opened_at: null }, partner: PARTNER } });
    await G.handlePartnerText(guest, "(K7Q2MX)", { ...h.deps, now: before });
    check("not open yet: one line, no guest row", h.sent[0] === "not open Demo Night" && guests.length === 0);
    const savedUrl = process.env.API_URL;
    process.env.API_URL = "https://api.example.com";
    const P = await import("../../src/services/partners.js");
    const h2 = harness();
    const next = { ...NIGHT, api_id: "partner-bb", name: "Second Night", code: "M4R8TW", start_at: "2026-12-05T02:00:00.000Z", end_at: "2026-12-05T06:00:00.000Z" };
    // nextOpenNight reads partner_events: answered here.
    const q0 = pool.query;
    pool.query = async (q: string, p: any[]) => (/FROM partner_events WHERE partner_id/.test(q) ? { rows: [next] } : fake(q, p));
    await G.handlePartnerText(guest, "(K7Q2MX)", { ...h2.deps, now: afterClose });
    pool.query = q0;
    check("late scan by text: that night's over, here's their next night", h2.sent[0] === "over; next Second Night https://api.example.com/r/M4R8TW" && guests.length === 0);
    linesRecent = 1;
    await G.handlePartnerText(guest, "(K7Q2MX)", { ...h2.deps, now: afterClose });
    check("late scan by text: at most once a day", h2.sent.length === 1);
    linesRecent = 0;
    const h3 = harness();
    await G.handlePartnerText(guest, "(K7Q2MX)", { ...h3.deps, now: afterClose });
    check("late scan, no next night: the one line", h3.sent[0] === "over Demo Night");
    if (savedUrl === undefined) delete process.env.API_URL;
    else process.env.API_URL = savedUrl;
    void P;
  }
  setCopy(false);

  // The cutoff, as every send path reads it.
  {
    const db = (rows: any[]) => ({ query: async () => ({ rows }) });
    const row = { member: false, resolved_at: null, start_at: NIGHT.start_at, end_at: NIGHT.end_at, timezone: NIGHT.timezone, closed_at: null };
    check("cutoff read: a guest after close is held", !(await G.proactiveCutoff("u", afterClose, db([row]))).pass);
    check("cutoff read: during the night passes", (await G.proactiveCutoff("u", during, db([row]))).pass);
    check("cutoff read: a member with an old guest night passes", (await G.proactiveCutoff("u", afterClose, db([{ ...row, member: true }]))).pass);
    check("cutoff read: a member with no guest rows passes", (await G.proactiveCutoff("u", afterClose, db([{ member: true, resolved_at: null, start_at: null }]))).pass);
    check("cutoff read: a failed read holds the send", !(await G.proactiveCutoff("u", during, { query: async () => { throw new Error("down"); } })).pass);
  }

  // The cutoff on the send paths themselves: an exempt send and an in-room send to a guest after close never go out.
  {
    const q0 = pool.query;
    const c0 = pool.connect;
    const guestRow = { member: false, resolved_at: null, start_at: NIGHT.start_at, end_at: NIGHT.end_at, timezone: NIGHT.timezone, closed_at: null };
    const sendFake = async (q: string) => {
      if (/COALESCE\(sms_opted_out, false\) AS opted_out/.test(q)) return { rows: [{ opted_out: false }] };
      if (/FROM users u LEFT JOIN partner_guests/.test(q)) return { rows: [guestRow] };
      return { rows: [], rowCount: 0 };
    };
    pool.query = sendFake;
    pool.connect = async () => ({ query: sendFake, release: () => {} });
    const H = await import("../../src/harness/proactive.js");
    const r = await H.sendExempt({ userId: "u-guest", phoneNumber: "+15550100", type: "co_event" as any, targetKey: "x", messages: ["hello"], now: afterClose }).catch((e: any) => ({ sent: "threw", reason: String(e?.message ?? e) }));
    check("send path: an exempt send to a guest after close is refused", r.sent === false && /cutoff/.test(String(r.reason)));
    // In-room reads the real clock: a resolved guest is past the cutoff whatever the date.
    guestRow.resolved_at = new Date("2026-10-01T00:00:00Z") as any;
    check("send path: an in-room send to a former guest is refused", (await H.inRoomSendAllowed("u-guest", "partner-aa")) === false);
    pool.query = async (q: string) => (/FROM users u LEFT JOIN partner_guests/.test(q) ? { rows: [{ member: true, resolved_at: null, start_at: null }] } : { rows: [] });
    check("send path: a member's in-room send isn't touched by it", (await H.inRoomSendAllowed("u-member", "evt-1")) === true);
    pool.query = q0;
    pool.connect = c0;
  }

  // Forget by default at close.
  {
    sql.length = 0;
    const q0 = pool.query;
    let others: any[] = [];
    const closeFake = async (q: string, p: any[] = []) => {
      sql.push({ q, p });
      if (/SELECT g\.id, g\.user_id, coalesce\(u\.invite_verified/.test(q)) return { rows: [{ id: "g1", user_id: "u-guest", member: false }, { id: "g2", user_id: "u-joined", member: true }] };
      if (/SET resolved_at = \$2, resolution = 'forgotten'/.test(q)) return { rows: [{ id: p[0] }] };
      if (/SELECT 1 FROM partner_guests WHERE user_id = \$1 AND resolved_at IS NULL/.test(q)) return { rows: others };
      return { rows: [], rowCount: 1 };
    };
    pool.query = closeFake;
    pool.connect = async () => ({ query: closeFake, release: () => {} });
    const r = await G.resolveGuests("partner-aa", afterClose);
    const wipe = sql.find((c) => /resolution = 'forgotten'/.test(c.q));
    const del = sql.find((c) => /DELETE FROM co_memories/.test(c.q));
    const joined = sql.find((c) => /resolution = 'joined'/.test(c.q));
    check("forget: a silent guest's answers are wiped", r.forgotten === 1 && !!wipe && /who = NULL, work = NULL, hoping = NULL/.test(wipe.q) && wipe.p[0] === "g1");
    check("forget: and their logged texts with Cue are deleted", !!del && del.p[0] === "u-guest" && /memory_type = 'text_exchange'/.test(del.q));
    check("forget: a guest who joined keeps what they said (nothing wiped or deleted for them)", r.joined === 1 && joined?.p[0] === "g2" && !sql.some((c) => /DELETE/.test(c.q) && c.p[0] === "u-joined"));
    sql.length = 0;
    others = [{ "?column?": 1 }];
    await G.resolveGuests("partner-aa", afterClose);
    check("forget: texts wait while another of their nights is still live", !sql.some((c) => /DELETE FROM co_memories/.test(c.q)));
    pool.query = q0;
  }

  // The close job.
  {
    const q0 = pool.query;
    sql.length = 0;
    const events = [
      { api_id: "partner-aa", start_at: NIGHT.start_at, end_at: NIGHT.end_at, timezone: NIGHT.timezone, closed_at: null },
      { api_id: "partner-cc", start_at: "2026-11-07T05:00:00Z", end_at: "2026-11-07T09:00:00Z", timezone: null, closed_at: null },
    ];
    const jobFake = async (q: string, p: any[] = []) => {
      sql.push({ q, p });
      if (/SELECT DISTINCT e\.api_id/.test(q)) return { rows: events };
      return { rows: [], rowCount: 1 };
    };
    pool.query = jobFake;
    pool.connect = async () => ({ query: jobFake, release: () => {} });
    const done = await G.runPartnerNightCloses(afterClose);
    check("close job: a due night closes (code dies) and its guests resolve", done.length === 1 && done[0].eventId === "partner-aa" && sql.some((c) => /UPDATE partner_events SET closed_at = NOW\(\)/.test(c.q) && c.p[0] === "partner-aa"));
    check("close job: a night still on is left alone", !sql.some((c) => /UPDATE partner_events SET closed_at/.test(c.q) && c.p[0] === "partner-cc"));
    pool.query = q0;
  }
} finally {
  setCopy(false);
  pool.query = realQuery;
  pool.connect = realConnect;
}

// ---------------------------------------------------------------- copy and wiring
{
  const guestKeys = Object.keys(C.PARTNER_COPY).filter((k) => k.startsWith("guest_"));
  check("copy: as shipped, every guest text waits on Royce", guestKeys.length === 10 && guestKeys.every((k) => (C.PARTNER_COPY as any)[k] === C.PENDING));
  const svc = src("src/services/partnerGuests.ts");
  const code = svc.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  check("copy: a guest is only ever sent a line from copyFor (one send, inside say)", (code.match(/deps\.send\(/g) ?? []).length === 1 && /const line = copyFor\(key/.test(code));
  check("never first: nothing here sends except as a reply (no proactive path)", !/sendExempt|enqueueCandidate|sendblue/.test(code));
  check("their words stay scoped: nothing writes co_profiles, co_facts or the people graph", !/co_profiles|co_facts|captureIntent|peopleGraph|writeMemory/.test(code));
  const route = src("src/routes/sendblue.ts");
  const at = route.indexOf("await handlePartnerText(");
  check("route: guests are handled before the invite gate (no code asked of a guest)", at > 0 && at < route.indexOf("if (!user.invite_verified) {\n          // Even on the very first-ever message") && at > route.indexOf("isOptOutKeyword(content)"));
  check("route: a member at the door gets the walk-in check-in and arrival", /partner\.memberCheckin\.eventApiId, user\.id\)[\s\S]{0,300}markArrived\(partner\.memberCheckin\.eventApiId, user\.id, "text"\)[\s\S]{0,120}walkinCheckinEventName = partner\.memberCheckin\.eventName/.test(route));
  const pro = src("src/harness/proactive.ts");
  check("cutoff: every proactive send path reads it (daily pick, exempt sends, in-room)", (pro.match(/proactiveCutoff\(/g) ?? []).length === 3 && /checks\.push\(await \(await import\("\.\.\/services\/partnerGuests\.js"\)\)\.proactiveCutoff\(person\.userId, now, client\)\)/.test(pro) && /blocked_guest_cutoff/.test(pro) && /proactiveCutoff\(userId\)\)\.pass\) return false;/.test(pro));
  check("close: runs with the room-close job", /runPartnerNightCloses\(\)/.test(src("src/jobs/index.ts")));
  const mig = src("src/db/migrations.ts");
  check("table: partner_guests, one row per guest per night", /CREATE TABLE IF NOT EXISTS partner_guests/.test(mig) && /UNIQUE \(event_api_id, user_id\)/.test(mig));
}

console.log(`partner guests: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
