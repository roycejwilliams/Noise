// The quiet-member taper (Royce, 2026-10-14: "the taper only slows searching ... Instant resume ... Anything found while tapered is held
// and surfaces on resume ... Engaged members are untouched"). 40 and 41 are the cadence and resume decisions (no model call); 42 and 43
// run the real picker (recorded). The clock is the harness's (2026-10-13T21:00:00Z, evals/lib/goldenReplay.mjs GOLDEN_NOW).
import "../../lib/requireMeter.js";
import { goalHash } from "../../../src/services/goalEdges.js";
import type { MemberKnowledge } from "../../../src/services/memberKnowledge.js";
import { selectForMember, tierOf, type SelectContext } from "../../../src/services/sweepSelect.js";
import { factsFromKnowledge } from "../../../src/services/sweepSelectContext.js";
import { floorDoneToday, quietTapered, searchCadence } from "../../../src/services/dailySweep.js";
import { holdWhileQuiet, shadowKey, buildShadowPool } from "../../../src/services/sweepShadow.js";
import { result, type GoldenCase } from "../types.js";

const Z = "America/Los_Angeles";
const NOW = () => new Date();
const daysAgo = (n: number) => new Date(NOW().getTime() - n * 86_400_000);
// The picker's held run, with the real silence check and stubbed store writes.
const quietDeps = (lastInboundAt: Date | null, log: string[]) => ({
  silence: async (_u: string, now: Date) => (quietTapered({ now, zone: Z, lastInboundAt }) ? ("quiet" as const) : ("engaged" as const)),
  prunePast: async () => { log.push("prunePast"); return { exited: 0 }; },
  record: (async (d: any) => { log.push(`${d.action}`); }) as any,
});

// ---------------------------------------------------------------- 40
// Silent for 9 days, inside the tapered band (from 7 days of silence, every 3 days: SEARCH_TAPER.dailyUpToDays = 6).
const silentTapered: GoldenCase = {
  n: 40,
  id: "taper-silent-member",
  title: "A member silent 9 days gets the tapered cadence: searched every 3 days, finds held, no picker run",
  status: { live: true },
  from: "Royce 2026-10-14: \"(a) silent-7-day member gets the tapered cadence\" (9 days: 7 is still daily with today's thresholds)",
  run: async () => {
    const lastInbound = daysAgo(9);
    const offDay = searchCadence({ now: NOW(), zone: Z, lastInboundAt: lastInbound, lastSearchAt: daysAgo(1) });
    const onDay = searchCadence({ now: NOW(), zone: Z, lastInboundAt: lastInbound, lastSearchAt: daysAgo(3) });
    const log: string[] = [];
    const held = await holdWhileQuiet("u-rina", "2026-10-13", NOW(), quietDeps(lastInbound, log));
    const misses: string[] = [];
    if (offDay.search || offDay.everyDays !== 3) misses.push(`searched a day after the last search (${offDay.why})`);
    if (!onDay.search) misses.push(`not searched on its third day (${onDay.why})`);
    if (!/^tapered: quiet 9 days, next search \d{4}-\d{2}-\d{2}$/.test(offDay.why)) misses.push(`the tapered day isn't said as such: ${offDay.why}`);
    if (held !== "held" || log.join() !== "prunePast,tapered_hold") misses.push(`the picker wasn't held while quiet (${log.join()})`);
    return result(misses, `off day: ${offDay.why}; search day: ${onDay.why}; picker: ${held} (${log.join(" > ")})`);
  },
};

// ---------------------------------------------------------------- 41
const replyResumes: GoldenCase = {
  n: 41,
  id: "taper-reply-resumes",
  title: "The quiet member replies: the next run is full cadence, the same day",
  status: { live: true },
  from: "Royce 2026-10-14: \"Instant resume: any reply or activity from the member restores full daily searching on the very next run\"",
  run: async () => {
    // Today's 9am was a tapered day; they write at noon; the next hourly tick decides.
    const nine = new Date(NOW().getTime() - 5 * 3_600_000);
    const replied = new Date(NOW().getTime() - 2 * 3_600_000);
    const done = floorDoneToday([{ action: "tapered", created_at: nine, proposal: {} }], replied);
    const cadence = searchCadence({ now: NOW(), zone: Z, lastInboundAt: replied, lastSearchAt: daysAgo(2) });
    const log: string[] = [];
    const held = await holdWhileQuiet("u-rina", "2026-10-13", NOW(), quietDeps(replied, log));
    const misses: string[] = [];
    if (done) misses.push("today's tapered record still counts as done after they wrote");
    if (!cadence.search || cadence.everyDays !== 1) misses.push(`not full cadence after the reply (${cadence.why})`);
    if (held !== "run") misses.push("the picker is still held after they wrote");
    return result(misses, `today's floor ${done ? "done" : "runs again now"}; cadence ${cadence.everyDays === 1 ? "daily" : `every ${cadence.everyDays}`} (${cadence.why}); picker ${held}`);
  },
};

// ---------------------------------------------------------------- 42, 43: the real picker
function member(name: string, wroteDaysAgo: number, texts: { from: "member" | "co"; text: string; at: Date }[]): MemberKnowledge {
  const at = NOW().toISOString();
  return {
    userId: `u-${name.toLowerCase()}`,
    asOf: at,
    identity: { firstName: name, city: "San Francisco", zone: Z, timeZone: Z, verifiedAt: at },
    goals: [{ text: "meet other climate founders who actually see each other", state: "active", reason: null, told: true, onFile: true, hash: goalHash("meet other climate founders who actually see each other"), verifiedAt: daysAgo(wroteDaysAgo + 5).toISOString() }],
    asks: [], delivered: [], carrying: [], lessons: [], corrections: [], preferences: [], claims: [], restraint: null,
    exchanges: texts.map((t) => ({ from: t.from, text: t.text, call: false, verifiedAt: t.at.toISOString() })),
    person: null, limits: null,
  };
}

const heldSurfaces: GoldenCase = {
  n: 42,
  id: "taper-held-find-surfaces",
  title: "A find held on a tapered search day surfaces on the resume morning, competing under the normal rules",
  status: { live: true },
  from: "Royce 2026-10-14: \"(c) held finds surface on resume\"",
  run: async () => {
    // Rina went quiet 12 days ago. A tapered search day 4 days ago found a small climate founders' dinner series; it was held (no picker
    // run). She wrote this morning. The resume morning's pool: the held find (never judged) and a new find in another tier.
    const k = member("Rina", 0, [
      { from: "member", text: "I want a small group of climate founders who actually see each other. Dinners, a hike crew, not giant mixers.", at: daysAgo(20) },
      { from: "co", text: "Got it. Small rooms, climate people.", at: daysAgo(20) },
      { from: "member", text: "Sorry, went quiet. Back now and up for meeting people.", at: new Date(NOW().getTime() - 6 * 3_600_000) },
    ]);
    const raw = [
      { name: "Climate Founders Supper Club (8 seats)", date: "2026-10-22", tier: 3, askId: null, fromProfile: true, reminder: false, details: "a monthly dinner for 8 climate founders and operators, applications open; held from a tapered search day" },
      { name: "Bay Area Climate Hike", date: "2026-10-18", tier: 2, askId: null, fromProfile: true, reminder: false, details: "a 15-person Saturday hike for people working in climate" },
    ];
    // What the last picker run (before she went quiet) judged: neither of these.
    const pool = buildShadowPool(raw, "2026-10-13", new Map(), new Set(), new Set(), new Set([shadowKey("Some Older Mixer", null)]));
    const c: SelectContext = { ...factsFromKnowledge(k), today: "2026-10-13", weekday: "Tuesday", asks: [], sent: [], outcomes: [], discoveryLeft: 4, morning: true, pool };
    const quiet = quietTapered({ now: NOW(), zone: Z, lastInboundAt: new Date(NOW().getTime() - 6 * 3_600_000) });
    const r = await selectForMember(c, { userId: k.userId });
    const held = r.judgments.find((j) => j.name.startsWith("Climate Founders Supper Club"));
    const sends = r.judgments.filter((j) => j.verdict === "send");
    const misses: string[] = [];
    if (quiet) misses.push("she wrote this morning but still reads as tapered");
    if (r.error) misses.push(`picker error: ${r.error}`);
    if (held?.verdict !== "send") misses.push(`the held find didn't go on the resume morning (${held?.verdict}/${held?.reason})`);
    if (new Set(sends.map((j) => tierOf(c.pool.find((p) => p.id === j.id)!))).size !== sends.length) misses.push("two sends from one tier (a dump, not a normal morning)");
    if (sends.length > 3) misses.push(`${sends.length} sends: over the day's three`);
    return result(misses, r.judgments.map((j) => `${j.name.slice(0, 32)} ${j.verdict}/${j.reason}`).join("; "));
  },
};

const engagedUnchanged: GoldenCase = {
  n: 43,
  id: "taper-engaged-unchanged",
  title: "An engaged member's morning is unchanged: never tapered, never held, one find per tier",
  status: { live: true },
  from: "Royce 2026-10-14: \"Engaged members are untouched: 9am one-find-per-tier and full goal coverage run exactly as they do today\"",
  run: async () => {
    const wrote = daysAgo(2);
    const k = member("Ellis", 2, [
      { from: "member", text: "Run product at a small climate startup. Dinners and hikes with other founders would be great.", at: daysAgo(6) },
      { from: "co", text: "Noted: small rooms with climate builders.", at: daysAgo(6) },
      { from: "member", text: "Anything this week?", at: wrote },
    ]);
    const pool = buildShadowPool([
      { name: "Co Supper: Climate Builders", date: "2026-10-16", tier: 1, askId: null, fromProfile: true, reminder: false, details: "a Co dinner for 12 climate founders, Thursday 7pm" },
      { name: "Bay Area Climate Hike", date: "2026-10-18", tier: 2, askId: null, fromProfile: true, reminder: false, details: "a 15-person Saturday hike for people working in climate" },
      { name: "On Deck Climate Fellowship", date: "2026-11-15", tier: 3, askId: null, fromProfile: true, reminder: false, details: "a part-time fellowship for climate operators; applications close Nov 15" },
    ], "2026-10-13", new Map(), new Set());
    const c: SelectContext = { ...factsFromKnowledge(k), today: "2026-10-13", weekday: "Tuesday", asks: [], sent: [], outcomes: [], discoveryLeft: 4, morning: true, pool };
    const log: string[] = [];
    const held = await holdWhileQuiet(k.userId, "2026-10-13", NOW(), quietDeps(wrote, log));
    const cadence = searchCadence({ now: NOW(), zone: Z, lastInboundAt: wrote, lastSearchAt: daysAgo(1) });
    const r = await selectForMember(c, { userId: k.userId });
    const sends = r.judgments.filter((j) => j.verdict === "send");
    const tiers = sends.map((j) => tierOf(c.pool.find((p) => p.id === j.id)!));
    const misses: string[] = [];
    if (held !== "run" || log.length) misses.push(`an engaged member's picker was held or touched (${log.join()})`);
    if (!cadence.search || cadence.everyDays !== 1) misses.push(`an engaged member isn't searched daily (${cadence.why})`);
    if (r.error) misses.push(`picker error: ${r.error}`);
    if (new Set(tiers).size !== tiers.length) misses.push("two sends from one tier");
    for (const t of [1, 2, 3] as const) if (!tiers.includes(t) && !r.judgments.some((j) => tierOf(c.pool.find((p) => p.id === j.id)!) === t && j.verdict === "reject")) misses.push(`tier ${t} sent nothing without a verified reason`);
    return result(misses, `${r.judgments.map((j) => `${j.name.slice(0, 28)} ${j.verdict}/${j.reason}`).join("; ")}; picker ${held}; cadence ${cadence.why}`);
  },
};

export const CASES: GoldenCase[] = [silentTapered, replyResumes, heldSurfaces, engagedUnchanged];
