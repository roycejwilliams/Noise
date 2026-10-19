// Model-free checks for guests in matching at a partner night (services/partnerMatching.ts): a guest is scored from their own
// intake words only, under the same gates as every in-room match (shareable words, the bar, a share reason, the pair record,
// the value-line gate with no names), the pass runs only on an open room that changed, it writes pairs and sends nothing, and
// what it wrote about a guest is wiped when they're forgotten. No network, no database (stubbed), no model (scorer and value
// reads stubbed).
//
//   npx tsx evals/partners/matching.ts
import { readFileSync } from "fs";

const M = await import("../../src/services/partnerMatching.js");
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
const code = (p: string) => src(p).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

const NOOR = { user_id: "g-noor", who: "Noor Haddad", work: "I build robotics hardware", hoping: "seed investors who get hardware" };
const ELLIS = { user_id: "g-ellis", who: "Ellis", work: "angel investor in deep tech", hoping: "hardware founders raising a seed round" };
const QUIET = { user_id: "g-quiet", who: "Sam", work: null, hoping: null };

// ---------------------------------------------------------------- rules (pure)
{
  const s = M.guestScorable(NOOR);
  const intent = s.intent as any[];
  check("guest: scored on their own two answers, both shareable for the night", intent.length === 2 && intent.every((i) => i.shareable === true && i.status === "active") && intent.some((i) => i.type === "seeking" && i.text === NOOR.hoping) && intent.some((i) => i.type === "offering" && i.text === NOOR.work));
  check("guest: their name (who) never reaches the scorer", !JSON.stringify(s).includes("Noor") && s.first_name === "" && s.phone_number === "" && s.email === "");
  check("guest: nothing said, nothing to score on", (M.guestScorable(QUIET).intent as any[]).length === 0);
  const v = M.guestValueSide(NOOR);
  check("guest value side: no name, shares only their answers, their who is private", v.firstName === "this person" && v.shared.length === 2 && v.privateTexts.includes("Noor Haddad") && !v.shared.join(" ").includes("Noor"));
}
{
  const a = M.guestScorable(NOOR);
  const b = M.guestScorable(ELLIS);
  check("signature: the same room in any order is the same", M.roomSignature([a, b]) === M.roomSignature([b, a]));
  check("signature: a changed answer is a changed room", M.roomSignature([a, b]) !== M.roomSignature([a, M.guestScorable({ ...ELLIS, hoping: "climate founders" })]));
  check("signature: someone new is a changed room", M.roomSignature([a, b]) !== M.roomSignature([a, b, M.guestScorable(QUIET)]));
  const now = new Date("2026-11-07T03:00:00Z");
  check("due: only an open room", !M.passDue({ phase: "closing", signature: "x", last: null, now }).due && !M.passDue({ phase: "before", signature: "x", last: null, now }).due && M.passDue({ phase: "open", signature: "x", last: null, now }).due);
  check("due: not when nothing changed", !M.passDue({ phase: "open", signature: "x", last: { signature: "x", ran_at: new Date("2026-11-07T01:00:00Z") }, now }).due);
  check("due: not again within a few minutes", !M.passDue({ phase: "open", signature: "y", last: { signature: "x", ran_at: new Date(now.getTime() - 5 * 60_000) }, now }).due);
  check("due: a changed room after the gap", M.passDue({ phase: "open", signature: "y", last: { signature: "x", ran_at: new Date(now.getTime() - 11 * 60_000) }, now }).due);
}

// ---------------------------------------------------------------- the pass (stubbed)
const realQuery = pool.query;
const during = new Date("2026-11-07T03:00:00Z");
const NIGHT = { api_id: "partner-aa", partner_id: "p1", name: "Demo Night", start_at: "2026-11-07T02:00:00Z", end_at: "2026-11-07T06:00:00Z", timezone: "America/Los_Angeles", venue: null, address: null, code: "K7Q2MX", intake_opened_at: new Date("2026-11-01T00:00:00Z"), closed_at: null, id: "p1", slug: "hai", partner_name: "House of AI", rsvp_blurb: "{link}", host_name: null, host_email: null, rsvp_blurb_approved_by: "Royce", ended_at: null };
let pairs: any[] = [];
let lastPass: any = null;
let paused = false;
let night: any = NIGHT;
const decisions: any[] = [];
const sql: string[] = [];
pool.query = async (q: string, p: any[] = []) => {
  sql.push(q);
  if (/FROM partner_events e JOIN partners p/.test(q)) return { rows: night ? [night] : [] };
  if (/FROM matching_pauses/.test(q)) return { rows: paused ? [{ scope: "all", reason: "" }] : [] };
  if (/SELECT signature, ran_at, seen FROM partner_match_passes/.test(q)) return { rows: lastPass ? [lastPass] : [] };
  if (/UPDATE partner_match_passes SET signature = \$2, seen = \$3::jsonb WHERE event_api_id = \$1/.test(q)) {
    if (lastPass) Object.assign(lastPass, { signature: p[1], seen: JSON.parse(p[2]) });
    return { rows: [] };
  }
  if (/INSERT INTO partner_match_passes/.test(q)) {
    lastPass = { signature: p[1], ran_at: p[2], seen: JSON.parse(p[3]) };
    return { rows: [] };
  }
  if (/SELECT \* FROM co_pairs WHERE a_id = \$1 AND b_id = \$2/.test(q)) return { rows: pairs.filter((r) => r.a_id === p[0] && r.b_id === p[1]) };
  if (/INSERT INTO co_pairs/.test(q)) {
    if (!pairs.some((r) => r.event_id === p[0] && r.a_id === p[1] && r.b_id === p[2])) pairs.push({ event_id: p[0], a_id: p[1], b_id: p[2], origin: p[3], state: "suggested", value_verdict: null });
    return { rows: [] };
  }
  if (/UPDATE co_pairs SET value_line_a = \$4/.test(q)) {
    const r = pairs.find((x) => x.event_id === p[0] && x.a_id === p[1] && x.b_id === p[2]);
    Object.assign(r, { value_line_a: p[3], value_line_b: p[4], value_verdict: p[5], value_why: p[6], state: p[7] ? r.state : r.state === "suggested" ? "blocked" : r.state, blocked_reason: p[7] ? null : p[8] });
    return { rows: [] };
  }
  if (/INSERT INTO harness_decisions/.test(q)) {
    decisions.push({ decision: p[1], action: p[4], proposal: p[5] });
    return { rows: [] };
  }
  return { rows: [] };
};

const member = { user_id: "m-jordan", first_name: "Jordan", phone_number: "+15550100", email: "j@example.com", intent: [{ text: "hardware founders to back at seed", type: "offering", status: "active", shareable: true }, { text: "a new role without my cofounder knowing", type: "seeking", status: "active", shareable: false }] };
const memberSide = async (id: string) => ({ userId: id, firstName: "Jordan", ownAsks: [{ text: "hardware founders to back at seed", type: "offering", shareable: true }], goals: [], pastOutcomes: [], shared: ["hardware founders to back at seed"], privateAsks: ["a new role without my cofounder knowing"], privateTexts: ["a new role without my cofounder knowing"] });
const seenFrames: string[][] = [];
const judgeCalls: { reader: any; other: any }[] = [];
// Scores: Noor and Ellis are a strong fit both ways; Jordan and Noor too; Jordan and Ellis below the bar; the quiet guest isn't here.
const score = async (person: any, others: any[]) => {
  seenFrames.push((person.intent as any[]).map((i) => i.text));
  const s = (id: string) => (person.user_id === "g-noor" && id === "g-ellis") || (person.user_id === "g-ellis" && id === "g-noor") ? 85 : (person.user_id === "m-jordan" && id === "g-noor") || (person.user_id === "g-noor" && id === "m-jordan") ? 80 : 30;
  return others.map((o) => ({ candidate: o, score: s(o.user_id), reason: "internal", shareReason: s(o.user_id) >= 60 ? "their own words" : "", mutual: false }));
};
const strongLine = (reader: any, other: any) => ({ line: `Worth meeting: they ${other.shared[0]}, which fits what you're after tonight.`, verdict: "strong" as const, why: "fit" });
const deps = (o: any = {}) => ({ now: during, room: async () => ({ members: [member], guests: [NOOR, ELLIS] }), score, memberSide, judge: async (_e: string, reader: any, other: any) => (judgeCalls.push({ reader, other }), strongLine(reader, other)), ...o });

try {
  let r = await M.runPartnerMatchPass("partner-aa", deps());
  check("pass: runs on an open room", r.ran && r.room === 3 && r.guests === 2);
  check("pass: a member's private ask never reaches the scorer (shareable words only)", !seenFrames.flat().some((t) => /cofounder knowing/.test(t)));
  check("pass: guests are scored like anyone (their answers are their frame)", seenFrames.some((f) => f.includes(NOOR.hoping)));
  check("pass: pairs above the bar get the value gate; below it, nothing", r.suggested === 2 && r.belowBar >= 1 && pairs.length === 2 && !pairs.some((p) => [p.a_id, p.b_id].sort().join() === ["g-ellis", "m-jordan"].join()));
  check("pass: each pair judged once, not once per direction", judgeCalls.length === 4);
  check("value gate: no names on either side, the member's included", judgeCalls.every((c) => c.reader.firstName === "this person" && c.other.firstName === "this person"));
  check("value gate: a guest's name is never shared with the other side", judgeCalls.every((c) => !c.other.shared.join(" ").includes("Noor")));
  check("value gate: a strong pair is stored suggested, with its lines", pairs.every((p) => p.state === "suggested" && p.value_verdict === "strong" && p.value_line_a));
  check("log: counts and verdicts only, never anyone's words", decisions.length > 0 && !decisions.some((d) => /hardware|investor|Noor|Ellis|Worth meeting|cofounder/i.test(String(d.proposal ?? ""))));

  r = await M.runPartnerMatchPass("partner-aa", deps({ now: new Date(during.getTime() + 20 * 60_000) }));
  check("pass: an unchanged room isn't scored again", !r.ran && /hasn't changed/.test(r.why));
  // Someone new arrives: only they are scored against the room, and the room only against them.
  const SAM = { user_id: "g-sam", who: "Sam", work: "seed investor in robotics", hoping: "robotics founders" };
  const calls: { who: string; others: string[] }[] = [];
  r = await M.runPartnerMatchPass("partner-aa", deps({ now: new Date(during.getTime() + 40 * 60_000), room: async () => ({ members: [member], guests: [NOOR, ELLIS, SAM] }), score: async (person: any, others: any[]) => (calls.push({ who: person.user_id, others: others.map((o: any) => o.user_id) }), []) }));
  check("pass: a newcomer is scored against the whole room", r.ran && calls.find((c) => c.who === "g-sam")?.others.length === 3);
  check("changed: someone whose answer changed is scored again; nobody else", [...M.changedPeople([M.guestScorable(NOOR), M.guestScorable({ ...ELLIS, hoping: "climate founders" })], { [NOOR.user_id]: M.personSignature(M.guestScorable(NOOR)), [ELLIS.user_id]: M.personSignature(M.guestScorable(ELLIS)) })].join() === "g-ellis");
  check("pass: everyone else is scored against the newcomer only (a pass costs what changed)", calls.filter((c) => c.who !== "g-sam").every((c) => c.others.join() === "g-sam") && calls.length === 4);

  // Weak, a decline, the bar.
  pairs = [];
  lastPass = null;
  judgeCalls.length = 0;
  pairs.push({ event_id: "partner-old", a_id: "g-ellis", b_id: "g-noor", state: "declined", declined_at: new Date("2026-10-01T00:00:00Z"), value_verdict: null });
  r = await M.runPartnerMatchPass("partner-aa", deps({ judge: async () => ({ line: "You both like hardware, which is nice to chat about.", verdict: "weak", why: "generic" }) }));
  check("pair record: a pair either side declined anywhere is never suggested again", !pairs.some((p) => p.event_id === "partner-aa" && p.a_id === "g-ellis"));
  check("value gate: weak -> blocked, nothing suggested", r.suggested === 0 && r.blocked === 1 && pairs.find((p) => p.event_id === "partner-aa")?.state === "blocked");

  // A failed read stores nothing and is tried next pass.
  pairs = [];
  lastPass = null;
  r = await M.runPartnerMatchPass("partner-aa", deps({ judge: async () => "failed" }));
  check("value gate: a failed read stores no verdict", r.suggested === 0 && r.blocked === 0 && pairs.every((p) => !p.value_verdict));
  // ... and the next pass reads that pair again though nobody new arrived (review of #216: it used to rest as "the room hasn't
  // changed", so one transient error lost the pair for the night).
  r = await M.runPartnerMatchPass("partner-aa", deps({ now: new Date(during.getTime() + 20 * 60_000) }));
  check("value gate: after a failed read, the next pass tries the pair again and can suggest it", r.ran && r.suggested === 2 && pairs.filter((p) => p.event_id === "partner-aa").every((p) => p.value_verdict === "strong"), { r, pairs });
  r = await M.runPartnerMatchPass("partner-aa", deps({ now: new Date(during.getTime() + 40 * 60_000) }));
  check("... and once it's read, an unchanged room rests again", !r.ran && /hasn't changed/.test(r.why), r);
  // A scorer that throws is the same: the next pass scores that person again.
  pairs = [];
  lastPass = null;
  let throwOnce = true;
  r = await M.runPartnerMatchPass("partner-aa", deps({ score: async (person: any, others: any[]) => { if (throwOnce && person.user_id === "g-noor") { throwOnce = false; throw new Error("scorer down"); } return score(person, others); } }));
  const afterThrow = r.suggested;
  const scoredNext: string[] = [];
  r = await M.runPartnerMatchPass("partner-aa", deps({ now: new Date(during.getTime() + 20 * 60_000), score: async (person: any, others: any[]) => (scoredNext.push(person.user_id), score(person, others)) }));
  check("scorer: a person the scorer failed for is scored again next pass", afterThrow >= 0 && r.ran && scoredNext.includes("g-noor") && pairs.filter((p) => p.event_id === "partner-aa" && p.value_verdict === "strong").length === 2);
  // A read that keeps failing is retried on two later passes, then left (it never re-scores the room every pass until close).
  pairs = [];
  lastPass = null;
  const alwaysFails = deps({ judge: async () => "failed" });
  const ran: boolean[] = [];
  for (let k = 0; k < 6; k++) ran.push((await M.runPartnerMatchPass("partner-aa", { ...alwaysFails, now: new Date(during.getTime() + k * 20 * 60_000) })).ran);
  check("a read that keeps failing is retried on two later passes, then rests", JSON.stringify(ran) === JSON.stringify([true, true, true, false, false, false]), ran);

  // Not an open room, the pause, too few people.
  lastPass = null;
  night = { ...NIGHT, start_at: "2026-11-08T02:00:00Z", end_at: "2026-11-08T06:00:00Z" };
  check("pass: never before the room opens", !(await M.runPartnerMatchPass("partner-aa", deps())).ran);
  night = { ...NIGHT, closed_at: new Date("2026-11-07T02:30:00Z") };
  check("pass: never once the room closed", !(await M.runPartnerMatchPass("partner-aa", deps())).ran);
  night = NIGHT;
  paused = true;
  check("pass: the matching kill switch holds it", !(await M.runPartnerMatchPass("partner-aa", deps())).ran);
  paused = false;
  check("pass: one person is no room", !(await M.runPartnerMatchPass("partner-aa", deps({ room: async () => ({ members: [], guests: [NOOR] }) }))).ran);
  night = null;
  check("pass: only partner nights", !(await M.runPartnerMatchPass("evt-123", deps())).ran);
  night = NIGHT;
} finally {
  pool.query = realQuery;
}

// ---------------------------------------------------------------- the room (stubbed)
{
  const q0 = pool.query;
  pool.query = async (q: string) => {
    if (/FROM event_walkin_checkins ewc/.test(q)) return { rows: [{ user_id: "m-in" }, { user_id: "m-left" }, { user_id: "m-notyet" }] };
    if (/FROM event_presence WHERE event_api_id/.test(q)) return { rows: [{ user_id: "m-in", arrived_at: new Date(), left_at: null, not_going_at: null }, { user_id: "m-left", arrived_at: new Date(), left_at: new Date(), not_going_at: null }] };
    if (/FROM partner_guests g JOIN users u/.test(q)) {
      check("room: guests who arrived, unresolved, with something said, reachable", /g\.arrived_at IS NOT NULL AND g\.resolved_at IS NULL AND \(g\.hoping IS NOT NULL OR g\.work IS NOT NULL\)/.test(q) && /sms_opted_out/.test(q) && /archived_at IS NULL/.test(q));
      return { rows: [NOOR, { ...ELLIS, user_id: "m-in" }] };
    }
    return { rows: [] };
  };
  try {
    const room = await M.partnerRoom("partner-aa");
    check("room: members who checked in and arrived, not left, not arrived-yet", room.members.map((m) => m.user_id).join() === "m-in");
    check("room: someone who is both counts once, as a member", room.guests.map((g) => g.user_id).join() === "g-noor");
  } finally {
    pool.query = q0;
  }
}

// ---------------------------------------------------------------- close, forget, wiring
{
  const svc = code("src/services/partnerMatching.ts");
  check("sends nothing: no texting or email path in the matching pass", !/sendblue|sendExempt|enqueueCandidate|inRoomSendAllowed|resend|maybeSendMatchNudge|runEventAskSolicitationAgent/i.test(svc));
  check("never the Co-event flow: partner nights don't go through scoreMatchedGroup or inRoomPool", !/scoreMatchedGroup|scoreGuestListForEvent|inRoomPool\(/.test(svc));
  check("the bar is the in-room bar", /MATCH_NUDGE_MIN_SCORE/.test(svc) && /s\.score < MATCH_NUDGE_MIN_SCORE \|\| !s\.shareReason/.test(svc));
  check("the value read records no prompt or output in tracing", /functionId: "partnerMatching\.valueLine", recordInputs: false, recordOutputs: false/.test(svc));
  const guests = code("src/services/partnerGuests.ts");
  check("close: pairs still waiting expire with the room", /UPDATE co_pairs SET state = 'expired'[\s\S]{0,120}state IN \('suggested', 'asked'\)/.test(guests));
  // The exact statement and its arguments (review of #216: a shape match passed with "AND FALSE" added, which wipes nothing).
  check("forget: the value lines about a forgotten guest's pairs are wiped, the pair's state kept", guests.includes("await client.query(`UPDATE co_pairs SET value_line_a = NULL, value_line_b = NULL, value_why = NULL, updated_at = NOW() WHERE event_id = $1 AND (a_id = $2 OR b_id = $2)`, [eventId, r.user_id]);"));
  const jobs = src("src/jobs/index.ts");
  check("job: the pass runs before the close, every 5 minutes", jobs.indexOf("runPartnerMatchPasses()") > 0 && jobs.indexOf("runPartnerMatchPasses()") < jobs.indexOf("runPartnerNightCloses()"));
  check("table: one last-pass row per night", /CREATE TABLE IF NOT EXISTS partner_match_passes \(event_api_id TEXT PRIMARY KEY/.test(src("src/db/migrations.ts")));
}

console.log(`partner matching: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
