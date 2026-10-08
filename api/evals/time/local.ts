// Member-local time everywhere (Royce, 2026-10-07: "Co is time-aware at all times. Every decision that touches time runs against
// the member's local time, not the server's... The 9am-8pm send rule stays as is."; since 2026-10-08 the one window is 8am-9pm). Zero tokens, no DB: a fake db and a fake
// city lookup stand in for the stored zone; every other check is pure.
//   npx tsx evals/time/local.ts
import { readFileSync } from "node:fs";
import { DateTime } from "luxon";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";

const M = await import("../../src/services/memberTime.js");
const LH = await import("../../src/services/localHours.js");
const P = await import("../../src/harness/proactive.js");
const CG = await import("../../src/harness/callGate.js");
const ES = await import("../../src/services/eventSurfacingSweep.js");
const D = await import("../../src/services/dateGuard.js");
const F = await import("../../src/services/coFacts.js");
const CL = await import("../../src/services/claims.js");
const FL = await import("../../src/services/factLabels.js");
const TL = await import("../../src/services/timeline.js");
const AW = await import("../../src/services/askWindow.js");
const OL = await import("../../src/services/openLoops.js");
const FU = await import("../../src/services/followUps.js");
const AL = await import("../../src/services/askLifecycle.js");
const MT = await import("../../src/harness/memberThreads.js");
const MR = await import("../../src/harness/memberReflection.js");
const PS = await import("../../src/harness/personSnapshot.js");
const EO = await import("../../src/services/eventOrder.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ""}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const at = (iso: string) => new Date(iso);
const LA = "America/Los_Angeles";
const NY = "America/New_York";

// ---- 1. a stored zone, set from the city and refreshed when the city changes ------------------------------------------------
{
  let lookups = 0;
  const lookup = async (city: string) => { lookups++; return /new york/i.test(city) ? NY : /san francisco/i.test(city) ? LA : null; };
  const fresh = await M.zoneFromProfile({ city: "New York", timezone: null, timezone_city: null }, lookup);
  check("zone: no stored zone, a city on file: derived from the city and stored with it", fresh.zone === NY && fresh.store?.timezone === NY && fresh.store?.timezone_city === "New York" && lookups === 1, fresh);
  lookups = 0;
  const same = await M.zoneFromProfile({ city: "New York", timezone: NY, timezone_city: "new york " }, lookup);
  check("zone: the stored zone is used as is while the city is the one it came from (no lookup)", same.zone === NY && same.store === null && lookups === 0, same);
  const moved = await M.zoneFromProfile({ city: "San Francisco", timezone: NY, timezone_city: "New York" }, lookup);
  check("zone: a changed city re-derives and re-stores the zone (the travel signal is the city on file)", moved.zone === LA && moved.store?.timezone === LA && moved.store?.timezone_city === "San Francisco", moved);
  const failedLookup = await M.zoneFromProfile({ city: "Atlantis", timezone: NY, timezone_city: "New York" }, lookup);
  check("zone: a city that can't be placed keeps the last known zone and isn't marked refreshed", failedLookup.zone === NY && failedLookup.store === null, failedLookup);
  const noCity = await M.zoneFromProfile({ city: null, timezone: null, timezone_city: null }, lookup);
  check("zone: no city and nothing stored: unknown (the fallback applies)", noCity.zone === null && noCity.store === null && M.wordsZone(noCity.zone) === LA);

  // memberZone over a fake db: the first read stores, the next read doesn't touch the city lookup or the db again.
  const row: any = { city: "New York", timezone: null, timezone_city: null };
  const writes: any[][] = [];
  const db = {
    query: async (sql: string, args: unknown[]) => {
      if (/^UPDATE co_profiles SET timezone/.test(sql)) { writes.push(args as any[]); if (row.city === args[2]) { row.timezone = args[1]; row.timezone_city = args[2]; } return { rows: [] }; }
      if (/SELECT city, timezone, timezone_city FROM co_profiles/.test(sql)) return { rows: [{ ...row }] };
      throw new Error(`unexpected: ${sql}`);
    },
  };
  lookups = 0;
  const z1 = await M.memberZone("u1", { db, lookup });
  const z2 = await M.memberZone("u1", { db, lookup });
  check("memberZone: stores the derived zone once, then reads it back with no lookup", z1 === NY && z2 === NY && writes.length === 1 && lookups === 1 && row.timezone === NY, { z1, z2, writes: writes.length, lookups });
  row.city = "San Francisco";
  const z3 = await M.memberZone("u1", { db, lookup });
  check("memberZone: a city change (from any writer) refreshes the stored zone on the next read", z3 === LA && row.timezone === LA && row.timezone_city === "San Francisco" && writes.length === 2, { z3, row });
  const dead = { query: async () => { throw new Error("db down"); } };
  check("memberZone: never throws (a failed read is unknown, so the fallback applies)", (await M.memberZone("u1", { db: dead, lookup })) === null);
  check("both city writers refresh the stored zone right after writing it", /refreshMemberZone\(req\.params\.user_id\)/.test(src("routes/co.ts")) && /refreshMemberZone\(user_id\)/.test(src("services/profileExtraction.ts")));
  check("the migration adds co_profiles.timezone and timezone_city (additive)", /ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS timezone TEXT, ADD COLUMN IF NOT EXISTS timezone_city TEXT/.test(src("db/migrations.ts")));
}

// ---- 2. an unknown zone falls back to Pacific AS A ZONE (DST-correct), and texts and calls use the same rule ----------------
{
  // Before Nov 1, 2026 (PDT, UTC-7): 8am = 15:00Z, 9pm = 04:00Z next day.
  check("fallback, PDT: 7:59am Pacific is outside", !LH.isReasonableLocalHour(null, at("2026-10-30T14:59:00Z")));
  check("fallback, PDT: 8am Pacific is inside", LH.isReasonableLocalHour(null, at("2026-10-30T15:00:00Z")));
  check("fallback, PDT: 8:59pm Pacific is inside (the old 16:00-24:00 UTC window stopped at 5pm)", LH.isReasonableLocalHour(null, at("2026-10-31T03:59:00Z")));
  check("fallback, PDT: 9pm Pacific is outside", !LH.isReasonableLocalHour(null, at("2026-10-31T04:00:00Z")));
  // After Nov 1, 2026 (PST, UTC-8): 16:00Z is 8am, which the old UTC window allowed.
  check("fallback, PST: 15:00 UTC is 7am Pacific, outside (the old UTC window was a fixed-UTC guess)", !LH.isReasonableLocalHour(null, at("2026-11-03T15:00:00Z")));
  check("fallback, PST: 16:00 UTC is 8am Pacific, inside", LH.isReasonableLocalHour(null, at("2026-11-03T16:00:00Z")));
  check("fallback, PST: 8:30pm Pacific is inside, 9pm outside", LH.isReasonableLocalHour(null, at("2026-11-04T04:30:00Z")) && !LH.isReasonableLocalHour(null, at("2026-11-04T05:00:00Z")));
  check("fallback, PST: the next sendable hour from 6am Pacific is 8am Pacific (16:00Z)", M.nextSendable(at("2026-11-03T14:00:00Z"), null).toISOString() === "2026-11-03T16:00:00.000Z", M.nextSendable(at("2026-11-03T14:00:00Z"), null).toISOString());
  check("fallback, PST: the morning-after hour with no zone is 10am Pacific (18:00Z), not 17:00 UTC", P.nextLocalHour(at("2026-11-03T08:00:00Z"), null, 10).toISOString() === "2026-11-03T18:00:00.000Z", P.nextLocalHour(at("2026-11-03T08:00:00Z"), null, 10).toISOString());
  check("one documented fallback: localHours, memberTime, dateGuard and eventOrder all name the same zone", LH.FALLBACK_ZONE === LA && M.FALLBACK_ZONE === LA && D.DEFAULT_ZONE === LA && EO.CO_DEFAULT_TIMEZONE === LA);
  check("no fixed-UTC fallback is left in the gates", !/getUTCHours\(\)\s*>=\s*1[67]/.test(src("services/localHours.ts") + src("harness/proactive.ts") + src("harness/callGate.ts")) && !/UNKNOWN_TZ_WINDOW_UTC/.test(src("harness/callGate.ts")));

  // Texts and calls: the same answer at every half hour across the DST change, for an unknown zone and two real ones.
  let same = true;
  let bad: unknown = null;
  for (let t = at("2026-10-30T00:00:00Z").getTime(); t < at("2026-11-04T00:00:00Z").getTime(); t += 30 * 60_000) {
    for (const z of [null, LA, NY]) {
      const d = new Date(t);
      const a = P.localHourOk(d, z), b = CG.callHourOk(z, d), c = LH.isReasonableLocalHour(z, d);
      if (a !== b || b !== c) { same = false; bad = { at: d.toISOString(), z, text: a, call: b }; }
    }
  }
  check("texts and calls use one rule: localHourOk == callHourOk == isReasonableLocalHour, every half hour across Nov 1, three zones", same, bad);
  check("the rule itself is 8am-9pm (Royce, 2026-10-08)", LH.REASONABLE_HOUR_START === 8 && LH.REASONABLE_HOUR_END === 21);
}

// ---- 3. an evening event is still offerable at 6pm on the day, and expires at its start ---------------------------------------
{
  const evening: any = { tier: 2, kind: "public_event", event_api_id: "evt1", event_date: "2026-10-08", name: "Founders Supper", url: "https://lu.ma/x", reason: "r", details: { startAt: "2026-10-09T02:00:00Z", endAt: "2026-10-09T05:00:00Z", timezone: LA } };
  const sixPm = at("2026-10-09T01:00:00Z"); // 6pm PDT Oct 8
  const exp = ES.offerExpiresAt(evening, null, sixPm);
  check("an evening event's offer expires at its start (7pm Pacific), not 23:59 UTC (4:59pm Pacific)", exp.toISOString() === "2026-10-09T02:00:00.000Z", exp.toISOString());
  check("at 6pm on the day it is still offerable (before the expiry; the old expiry had passed an hour earlier)", sixPm < exp && sixPm > new Date(`${evening.event_date}T23:59:00Z`));
  check("at 6pm Pacific it isn't 'past' by the member's day (the UTC day is already tomorrow)", !ES.isPastEvent(evening, null, sixPm) && !ES.isPastEvent(evening, LA, sixPm));
  check("the send-time date check (dateGuard) still offers it at 6pm their time", D.offerable(D.readDates(D.itemDays(evening, LA), D.localToday(LA, sixPm))).ok);
  const dateOnly: any = { ...evening, details: undefined };
  check("an event with only a date expires at the end of that day in the event's (or their) zone", ES.offerExpiresAt(dateOnly, LA, sixPm).toISOString() === "2026-10-09T06:59:59.999Z", ES.offerExpiresAt(dateOnly, LA, sixPm).toISOString());
  check("a New York member's date-only event ends at midnight Eastern", ES.offerExpiresAt(dateOnly, NY, sixPm).toISOString() === "2026-10-09T03:59:59.999Z");
  const opp: any = { tier: 3, kind: "opportunity", name: "Grant", url: "https://x", reason: "r", deadline: "2026-10-10" };
  check("a deadline expires at the end of that day in their zone", ES.offerExpiresAt(opp, null, sixPm).toISOString() === "2026-10-11T06:59:59.999Z");
  const undated: any = { tier: 3, kind: "opportunity", name: "Open call", url: "https://x", reason: "r" };
  check("an undated opportunity keeps two weeks", ES.offerExpiresAt(undated, null, sixPm).getTime() - sixPm.getTime() === 14 * 86_400_000);
  check("the sweep queues with offerExpiresAt (no `${date}T23:59:00Z` left)", /expiresAt: offerExpiresAt\(match, zone\)/.test(src("services/eventSurfacingSweep.ts")) && !/new Date\(`\$\{date\}T23:59:00Z`\)/.test(src("services/eventSurfacingSweep.ts")));
}

// ---- 4. the ledger records a 6pm Pacific send as that Pacific day ----------------------------------------------------------
{
  const row = { relation: "sent", label: "Founders Supper", url: "https://lu.ma/x", at: at("2026-10-08T01:00:00Z") }; // 6pm PDT Oct 7
  check("ledger: a 6pm Pacific send is that Pacific day (Oct 7), not the UTC day (Oct 8)", F.ledgerLine(row, "2026-10-07", LA).startsWith("On 2026-10-07 "), F.ledgerLine(row, "2026-10-07", LA));
  check("ledger: with no zone known, the day is Pacific's too", F.ledgerLine(row, "2026-10-07", null).startsWith("On 2026-10-07 "));
  check("ledger: a New York member's same send is their day (Oct 7, 9pm ET)", F.ledgerLine(row, "2026-10-07", NY).startsWith("On 2026-10-07 "));
  const late = { ...row, at: at("2026-10-08T04:30:00Z") }; // 9:30pm PDT Oct 7 = 12:30am EDT Oct 8
  check("ledger: a late send is Oct 7 for a Pacific member and Oct 8 for a New York one", F.ledgerLine(late, "2026-10-08", LA).startsWith("On 2026-10-07 ") && F.ledgerLine(late, "2026-10-08", NY).startsWith("On 2026-10-08 "));
  const lines = F.ledgerLinesFrom([row], "did you send that?", at("2026-10-08T02:00:00Z").getTime(), LA);
  check("ledger: the lines Co reads carry the member's day", lines.length === 1 && lines[0].startsWith("On 2026-10-07 "), lines);
  check("ledgerFacts reads the member's zone", /zoneIn !== undefined \? zoneIn : await memberZone\(userId\)/.test(src("services/coFacts.ts")));
}

// ---- 5. the date guard and claims use the member's zone (a New York member at 1am ET) ------------------------------------
{
  const oneAmET = at("2026-10-08T05:00:00Z"); // 1am EDT Oct 8 = 10pm PDT Oct 7
  check("date guard: today for a New York member at 1am ET is Oct 8 (Pacific would say Oct 7)", D.localToday(NY, oneAmET) === "2026-10-08" && D.localToday(LA, oneAmET) === "2026-10-07");
  const yesterdayEvent = { event_date: "2026-10-07" };
  check("date guard: yesterday's event is past for them at 1am ET, though it's still 'today' in Pacific", D.readDates(D.itemDays(yesterdayEvent, NY), D.localToday(NY, oneAmET)).status === "past" && D.readDates(D.itemDays(yesterdayEvent, LA), D.localToday(LA, oneAmET)).status === "today");
  const startAt = { details: { startAt: "2026-10-08T03:30:00Z" } }; // 11:30pm ET Oct 7 / 8:30pm PT Oct 7
  check("date guard: an event page's start is read as their local day", D.itemDays(startAt, NY).start === "2026-10-07" && D.itemDays(startAt, null).start === "2026-10-07");
  check("date guard callers pass the member's zone (registry, reply grounding, reveal)", /itemDays\(p\.match, person\.timezone\), localToday\(person\.timezone\)/.test(src("harness/proactiveRegistry.ts")) && /itemDays\(match, zone\), localToday\(zone\)/.test(src("harness/replyGrounding.ts")) && /recentSearchNotes\(userId, zone\)/.test(src("harness/replyGrounding.ts")));

  const words = CL.theirWordsOf([{ content: "User said: I'm pitching investors tomorrow", created_at: oneAmET }], NY);
  check("claims: what they said at 1am ET is dated their day (Oct 8)", words[0]?.at === "2026-10-08", words);
  check("claims: in Pacific the same words would be dated Oct 7", CL.theirWordsOf([{ content: "User said: hi", created_at: oneAmET }], LA)[0]?.at === "2026-10-07");
  const plan = { expiresOn: "2026-10-08" };
  check("claims: a claim that ends Oct 8 is gone for a New York member at 1am ET, still live in Pacific", !FL.isLive(plan, oneAmET, NY) && FL.isLive(plan, oneAmET, LA));
  const st = FL.stampOf({ saidOn: "2026-10-06", confirmedOn: "2026-10-06", dueOn: "2026-10-07" }, oneAmET, NY);
  const stLA = FL.stampOf({ saidOn: "2026-10-06", confirmedOn: "2026-10-06", dueOn: "2026-10-07" }, oneAmET, LA);
  check("claims: a thread dated Oct 7 has passed for them at 1am ET (not yet in Pacific)", st.datePassed && !stLA.datePassed, [st.label, stLA.label]);
  check("claims: refresh and the live read use the member's zone", /memberZone\(userId\)/.test(src("services/claims.ts")) && !/"America\/Los_Angeles"/.test(src("services/claims.ts")) && !/"America\/Los_Angeles"/.test(src("services/factLabels.ts")));
  check("loops: no fixed Pacific zone and no 23:59:59Z due-date end", !/LOOP_ZONE = "America\/Los_Angeles"/.test(src("services/openLoops.ts")) && !/T23:59:59Z/.test(src("services/openLoops.ts")));
  const loop: any = { taskId: 1, status: "open", changedAt: at("2026-10-08T00:00:00Z"), seenAt: null, wokeAt: at("2026-10-08T23:30:00Z"), dueDate: "2026-10-10" };
  const now = at("2026-10-09T00:30:00Z");
  check("loops: a due date ends at the end of their day (Pacific: 2 days 6.5h away, not urgent; the UTC end said urgent)", !OL.shouldWake(loop, now, LA) && new Date("2026-10-10T23:59:59Z").getTime() - now.getTime() <= OL.URGENT_WITHIN_DAYS * 86_400_000);
  check("loops: describeLoops reads 'today' in the zone it's given", OL.describeLoops([{ title: "Pitch", status: "open", detail: null, dueDate: "2026-10-07", source: "thread", lastConfirmedAt: oneAmET, decayAskedAt: null, closedAt: null, closedReason: null } as any], { now: oneAmET, zone: NY }) !== undefined);
}

// ---- 6. the timeline's local day -----------------------------------------------------------------------------------------
{
  const sixPmPT = at("2026-10-08T01:00:00Z"); // 6pm PDT Oct 7; the DB's CURRENT_DATE is Oct 8
  const d = TL.timelineDays(sixPmPT, LA);
  check("timeline: at 6pm Pacific, today is Oct 7 (SQL CURRENT_DATE would say Oct 8)", d.today === "2026-10-07" && d.from === "2026-10-06" && d.until === "2026-10-21", d);
  check("timeline: no zone known reads Pacific's day too", TL.timelineDays(sixPmPT, null).today === "2026-10-07");
  check("timeline: a New York member at 1am ET is on Oct 8", TL.timelineDays(at("2026-10-08T05:00:00Z"), NY).today === "2026-10-08");
  check("timeline: the queries take the day from code, not CURRENT_DATE", !/CURRENT_DATE [-+]|>= CURRENT_DATE/.test(src("services/timeline.ts")) && /timelineDays\(now, found\)/.test(src("services/timeline.ts")));
}

// ---- 7. "tomorrow" at 1am, "tonight" late --------------------------------------------------------------------------------
{
  const oneAm = DateTime.fromISO("2026-10-08T01:00", { zone: LA });
  const tm = AW.resolveAskWindow("anything fun tomorrow?", oneAm).window;
  check("askWindow: 'tomorrow' said at 1am is the day about to start (Oct 8), not Oct 9", tm?.start.toISODate() === "2026-10-08" && tm?.end.toISODate() === "2026-10-08", tm && { s: tm.start.toISO(), e: tm.end.toISO() });
  const tenAm = DateTime.fromISO("2026-10-08T10:00", { zone: LA });
  check("askWindow: 'tomorrow' at 10am is still the next day", AW.resolveAskWindow("anything tomorrow?", tenAm).window?.start.toISODate() === "2026-10-09");
  const elevenPm = DateTime.fromISO("2026-10-08T23:00", { zone: LA });
  const tn = AW.resolveAskWindow("what's on tonight", elevenPm).window;
  check("askWindow: 'tonight' at 11pm runs from now to the end of the day (non-empty, never in the past)", !!tn && +tn.start === +elevenPm && tn.end > tn.start && tn.end.toISODate() === "2026-10-08");
  const tn1 = AW.resolveAskWindow("anything tonight?", oneAm).window;
  check("askWindow: 'tonight' at 1am is the night under way (now to 5am), not the whole next evening", !!tn1 && +tn1.start === +oneAm && tn1.end.hour === 5 && tn1.end.toISODate() === "2026-10-08");
  check("askWindow and memberTime agree on 'tomorrow' at 1am", DateTime.fromJSDate(M.windowFromWords("tomorrow", oneAm.toJSDate(), LA)!.deadline).setZone(LA).toISODate() === "2026-10-08");
}

// ---- 8. models see member-local times with the zone named ----------------------------------------------------------------
{
  const zoneNamed = (s: string) => /\b(PDT|PST|EDT|EST)\b/.test(s);
  check("localStamp names the zone, before and after DST", zoneNamed(M.localStamp("2026-10-08T01:00:00Z", LA)) && /PST/.test(M.localStamp("2026-11-04T01:00:00Z", null)));
  const task: any = { id: 1, goal: "ask how the pitch went", wakes: 1, followup: { summary: "pitch", type: "companion", payload: { until: "2026-10-09T01:00:00Z" } } };
  const fp = FU.followUpPrompt({ task, firstName: "Jordan", recent: "", recentSends: "", now: M.localStamp(at("2026-10-08T23:00:00Z"), NY), zone: NY });
  check("follow-ups: 'Now:' and the deadline are local with the zone named", /Now: Thu Oct 8, 7pm EDT/.test(fp) && /go out by Thu Oct 8, 9pm EDT/.test(fp), fp.match(/Now: [^.]*\./)?.[0]);
  // Recent sends are relative ages ("5h ago", tasks/looseEnds.ts: they need no zone and fixed the decider); the clock and the
  // go-out-by time are local with the zone named.
  check("follow-ups: recent sends need no zone (relative ages), the clock and deadline are local", /ago\(/.test(src("services/followUps.ts")) && /now: localStamp\(deps\.now\(\), deps\.zone \?\? null\)/.test(src("services/followUps.ts")) && /localStamp\(o\.task\.followup\.payload\.until, o\.zone \?\? null\)/.test(src("services/followUps.ts")));
  check("task start (did_this_turn) shows local times, never bare UTC", !/UTC/.test(src("agent/conversationTools.ts").split("\n").filter((l) => /did_this_turn/.test(l)).join("\n")));
  const jp = AL.judgePrompt([{ n: "A1", text: "find a venue", kind: "find", since: "2026-10-07" }], [{ at: "2026-10-08T01:00:00Z", side: "member", text: "found one" }], LA);
  check("ask judge: the conversation is stamped in their time, zone named", /\[Wed Oct 7, 6pm PDT\] Member: found one/.test(jp));
  const tp = MT.threadsPrompt("Jordan", [], [{ at: "2026-10-08T01:00", text: "pitching Friday" }], LA);
  check("threads: their lines are stamped in their time, zone named", /\[Wed Oct 7, 6pm PDT\] pitching Friday/.test(tp));
  const rp = MR.reflectionPrompt("Jordan", { sends: [{ type: "companion", purpose: "companion", at: "2026-10-08T01:00", message: "hi" }], replies: 0, lastReplyAt: null, offerShare: null, threads: [], zone: NY });
  check("reflection: sends are stamped in their time, zone named", /\[Wed Oct 7, 9pm EDT\] \(companion\)/.test(rp));
  const sp = PS.snapshotPrompt({ firstName: "Jordan", previous: null, recentStatements: [{ at: "2026-10-08T01:00", text: "hi" }], openAsks: [], outcomes: [], zone: LA });
  check("snapshot: their words are stamped in their time, zone named", /\[Wed Oct 7, 6pm PDT\] hi/.test(sp));
  check("still-relevant read shows both times local with the zone", /const day = \(d: Date\) => localStamp\(d, about\.timezone\)/.test(src("harness/proactive.ts")));
}

console.log(`member-local time: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
