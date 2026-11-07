// Memory Spec step 7: one lookup of everything Cue sent a member, no window; dedupe by link and event. Zero tokens, a fake database.
//   npx tsx evals/sentLookup/run.ts
import { findSent, matchSent, mergeSentRecords, probeOfMatch, sentByReferent, sentOnce, wasSent, type SentRecord } from "../../src/services/knowledge/sent.js";
import { buildShadowPool } from "../../src/services/sweepShadow.js";
import { mergeDelivered } from "../../src/services/memberKnowledge.js";
import { normUrlOf } from "../../src/services/turnContext.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
  }
};

// A fake database by owner: every query must bind the member as $1, and only that member's rows come back.
type Db = Record<string, { facts?: any[]; offers?: any[]; revealed?: any[]; acts?: any[] }>;
const fakeQ = (db: Db, seen: string[] = []) => async (sql: string, args: unknown[]) => {
  const uid = String(args[0]);
  seen.push(`${uid}|${/\$1/.test(sql)}`);
  const w = db[uid] ?? {};
  if (/FROM co_facts/.test(sql) && /meta \? 'ledger'/.test(sql) && !/NOT \(meta/.test(sql)) return w.acts ?? [];
  if (/FROM co_facts/.test(sql)) return w.facts ?? [];
  if (/FROM proactive_candidates/.test(sql)) return w.offers ?? [];
  if (/FROM revealed_offers/.test(sql)) return w.revealed ?? [];
  throw new Error(`unexpected query ${sql.slice(0, 60)}`);
};
const long = new Date("2026-08-01T00:00:00Z"); // 100+ days before the 45-day window of the old reads
const NOW = new Date("2026-11-06T00:00:00Z");
const mk = (o: Partial<SentRecord> & { name: string }): SentRecord => ({ url: null, eventId: null, ident: { name: o.name }, kind: "event", at: long, via: ["offer"], reaction: null, ...o });

// ---------------------------------------------------------------- the match rule
{
  const recs = [mk({ name: "Founder Dinner", url: "https://lu.ma/fd-oct", eventId: "evt-1", ident: { name: "Founder Dinner", event_date: "2026-10-12" } })];
  check("same link, different name: a duplicate", findSent(recs, { name: "Dinner for Founders (SF)", url: "https://luma.com/fd-oct?utm=x" })?.by === "url");
  check("lu.ma and luma.com are one link", normUrlOf("https://lu.ma/a/") === normUrlOf("http://www.luma.com/a?utm_source=x"));
  check("same event id, another link and name: a duplicate", findSent(recs, { name: "Something else", url: "https://elsewhere.com/x", eventId: "evt-1" })?.by === "event");
  check("recurring: same name, new id and date: NOT a duplicate", !wasSent(recs, { name: "Founder Dinner", url: "https://lu.ma/fd-nov", eventId: "evt-2", ident: { name: "Founder Dinner", event_date: "2026-11-09" } }));
  check("recurring: same name, new date only: NOT a duplicate", !wasSent(recs, { name: "Founder Dinner", ident: { name: "Founder Dinner", event_date: "2026-11-09" } }));
  check("same name, same date, no ids: a duplicate", wasSent(recs, { name: "Founder Dinner", ident: { name: "Founder Dinner", event_date: "2026-10-12" } }));
  check("an opening (no id, no date) is matched by name", wasSent([mk({ name: "ERA Winter 2027 Cohort", kind: "opportunity" })], { name: "era winter 2027 cohort!" }));
  check("a different find is not a duplicate", !wasSent(recs, { name: "Poker Night", url: "https://lu.ma/poker" }));
  check("priority: a link beats a name", findSent([mk({ name: "A Night", url: "https://x.com/1" }), mk({ name: "Other", url: "https://x.com/2" })], { name: "A Night", url: "https://x.com/2" })?.by === "url");
  check("url-only records never match by name", matchSent(mk({ name: "Founder Dinner", url: "https://x.com/1", urlOnly: true }), { name: "Founder Dinner" }) === null);
  const m = probeOfMatch({ name: "X", url: "u", event_api_id: "e9", event_date: "2026-11-09" });
  check("a stored match is a probe with its id and date", m.eventId === "e9" && m.ident?.event_date === "2026-11-09");
  check("merge: same find from three sources is one record, latest time", (() => {
    const r = mergeSentRecords([mk({ name: "Pop-up", url: "https://x.com/p", at: long, via: ["fact"] }), mk({ name: "Pop-up!", url: "https://x.com/p/", at: NOW, via: ["ledger"], reaction: "interested" })]);
    return r.length === 1 && r[0].at === NOW && r[0].via.length === 2 && r[0].reaction === "interested";
  })());
  check("merge: a recurring event stays two records", mergeSentRecords([mk({ name: "Run Club", eventId: "a", ident: { name: "Run Club", event_date: "2026-10-01" } }), mk({ name: "Run Club", eventId: "b", ident: { name: "Run Club", event_date: "2026-10-08" } })]).length === 2);
}

// ---------------------------------------------------------------- the link: only tracking is dropped, a page with many finds isn't one find
{
  check("link: tracking params dropped (utm_*, ref, tk, fbclid, gclid)", normUrlOf("https://lu.ma/x?utm_source=a&utm_medium=b&ref=c&tk=d&fbclid=e&gclid=f") === normUrlOf("https://luma.com/x"));
  check("link: a meaningful query stays (garysguide ?region)", normUrlOf("https://www.garysguide.com/events?region=sf") !== normUrlOf("https://www.garysguide.com/events?region=nyc"));
  check("link: a meaningful query survives tracking around it, in any order", normUrlOf("https://example.org/event?utm_source=x&id=2&lang=en") === normUrlOf("https://example.org/event?lang=en&id=2&fbclid=y"));
  check("link: luma.com/event/x and luma.com/x are one link", normUrlOf("https://luma.com/event/abc123") === normUrlOf("https://lu.ma/abc123"));
  check("link: a Partiful id keeps its case", normUrlOf("https://partiful.com/e/AbCdE") !== normUrlOf("https://partiful.com/e/abcde"));
  check("link: other paths still fold case", normUrlOf("https://Lu.ma/Founder-Dinner/") === normUrlOf("https://luma.com/founder-dinner"));

  // A city-guide listing page: one link, many dated finds.
  const listing = "https://funcheap.com/city-guide/san-francisco-free-events/";
  const fc = [mk({ name: "Free Jazz in the Park", url: listing, ident: { name: "Free Jazz in the Park", event_date: "2026-11-08" } })];
  check("listing: another find on the same listing page (new name and date) is NOT a duplicate", !wasSent(fc, { name: "Night Market", url: listing, ident: { name: "Night Market", event_date: "2026-11-14" } }));
  check("listing: the same find on it again is a duplicate", findSent(fc, { name: "Free Jazz in the Park", url: listing, ident: { name: "Free Jazz in the Park", event_date: "2026-11-08" } })?.by === "url");
  // garysguide: one path, a region per query.
  const gg = [mk({ name: "SF Founders Meetup", url: "https://www.garysguide.com/events?region=sf" })];
  check("query: garysguide ?region=nyc is not the ?region=sf find", !wasSent(gg, { name: "NYC AI Night", url: "https://www.garysguide.com/events?region=nyc" }));
  // example.org/event?id=1 vs ?id=2
  const ex = [mk({ name: "Event One", url: "https://example.org/event?id=1" })];
  check("query: ?id=2 is not the ?id=1 find", !wasSent(ex, { name: "Event Two", url: "https://example.org/event?id=2" }));
  check("query: ?id=1 with tracking is the ?id=1 find", findSent(ex, { name: "Event 1", url: "https://example.org/event?id=1&utm_campaign=z" })?.by === "url");
  // A meetup group page: the same link, a new event id and date.
  const group = "https://www.meetup.com/sf-founders-circle/";
  const mu = [mk({ name: "SF Founders Monthly", url: group, eventId: "mu-301", ident: { name: "SF Founders Monthly", event_date: "2026-10-15" } })];
  check("group page: a new event id and date on the same link is NOT a duplicate", !wasSent(mu, { name: "SF Founders Monthly", url: group, eventId: "mu-344", ident: { name: "SF Founders Monthly", event_date: "2026-11-19" } }));
  check("group page: a new id alone on the same link is NOT a duplicate", !wasSent(mu, { name: "Founders Social", url: group, eventId: "mu-350" }));
  check("group page: the same id on the same link is a duplicate", findSent(mu, { name: "SF Founders Monthly", url: group, eventId: "mu-301" })?.by === "url");
  check("merge: two finds on one listing stay two records", mergeSentRecords([fc[0], mk({ name: "Night Market", url: listing, ident: { name: "Night Market", event_date: "2026-11-14" } })]).length === 2);

  // An undated reply-path fact (no id, no ISO date): its name never blocks a find that says which event it is.
  const fact = [mk({ name: "Founder Breakfast", via: ["fact"], ident: { name: "Founder Breakfast", event_date: "next Thursday" } })];
  check("fact: an undated fact doesn't block a dated find of the same name", !wasSent(fact, { name: "Founder Breakfast", ident: { name: "Founder Breakfast", event_date: "2026-12-04" } }));
  check("fact: an undated fact doesn't block an id'd find of the same name", !wasSent(fact, { name: "Founder Breakfast", eventId: "evt-fb-12" }));
  check("fact: an undated fact still blocks an undated find of the same name (an opening, a reply link)", wasSent(fact, { name: "Founder Breakfast" }));
  check("fact: an undated fact still blocks its own link", wasSent([mk({ ...fact[0], url: "https://lu.ma/fb" })], { name: "Founder Breakfast", url: "https://luma.com/fb", ident: { name: "Founder Breakfast", event_date: "2026-12-04" } }));
  check("offer: an undated offer record still blocks by name (only the fact record alone is loosened)", wasSent([mk({ name: "Founder Breakfast", via: ["offer"] })], { name: "Founder Breakfast", ident: { event_date: "2026-12-04" } }));
}

// ---------------------------------------------------------------- the merge: a long history in well under a second
{
  const parts: SentRecord[] = [];
  const base = Date.parse("2025-01-01T00:00:00Z");
  for (let i = 0; i < 2000; i++) {
    const series = i % 400; // 400 names, five sends each: recurrences, re-sends under another source, link-only ledger rows
    const name = `Series ${series} Night`;
    const day = new Date(base + (i * 86_400_000) / 4).toISOString().slice(0, 10);
    const via: SentRecord["via"] = [(["fact", "offer", "ledger"] as const)[i % 3]];
    parts.push(mk({ name, url: i % 2 ? `https://lu.ma/s${series}-${Math.floor(i / 400)}?utm_source=sms` : null, eventId: i % 3 ? `evt-${series}-${Math.floor(i / 400)}` : null, ident: { name, event_date: i % 5 ? day : null }, at: new Date(base + i * 3_600_000), via, urlOnly: i % 7 === 0 && i % 2 === 1 }));
  }
  const t0 = performance.now();
  const merged = mergeSentRecords(parts);
  const ms = performance.now() - t0;
  check(`merge: 2,000 records merge in well under 1s (${ms.toFixed(0)}ms)`, ms < 400, ms);
  // The worst shape: one name sent 2,000 times (a weekly series, its links, ids and dates all different).
  const one = parts.map((r, i) => ({ ...r, name: "Run Club", ident: { ...r.ident, name: "Run Club" }, url: r.url ? `https://lu.ma/rc-${i}` : null, eventId: r.eventId ? `rc-${i}` : null, via: [...r.via] }));
  const t2 = performance.now();
  const oneMerged = mergeSentRecords(one);
  const ms2 = performance.now() - t2;
  check(`merge: 2,000 sends of one name merge in under 1s (${ms2.toFixed(0)}ms)`, ms2 < 1000, ms2);
  check("merge: a dated weekly series isn't folded into one", oneMerged.length > 1000, oneMerged.length);
  check("merge: and still merges (fewer records than sends, more than names)", merged.length < 2000 && merged.length >= 400, merged.length);
  const t1 = performance.now();
  for (let i = 0; i < 200; i++) wasSent(merged, { name: `Series ${i} Night`, url: `https://luma.com/s${i}-9`, eventId: `evt-${i}-9`, ident: { event_date: "2027-06-01" } });
  check("lookup: 200 checks against the merged record are fast", performance.now() - t1 < 500, performance.now() - t1);
}

// ---------------------------------------------------------------- once per run, fail closed
{
  let reads = 0;
  const counting = async (sql: string, args: unknown[]) => { reads++; return fakeQ({ me: { offers: [{ match: { name: "Founder Dinner", event_api_id: "evt-1", tier: 1 }, at: NOW }] } })(sql, args); };
  const once = sentOnce(counting, "me");
  const [a, b] = await Promise.all([once(), once()]);
  await once();
  check("once: the record is read once per run (4 queries), however many checks", reads === 4 && a === b && !!a && a.length === 1, reads);
  const errs: unknown[] = [];
  const orig = console.error;
  console.error = (...x: unknown[]) => { errs.push(x); };
  const failing = sentOnce(async () => { throw new Error("db down"); }, "me");
  const f1 = await failing(), f2 = await failing();
  console.error = orig;
  check("once: a failed read is null (callers fail closed), logged once", f1 === null && f2 === null && errs.length === 1, errs.length);
}

// ---------------------------------------------------------------- the lookup: no window, owner only
{
  const db: Db = {
    me: {
      facts: [{ object_label: "the link to Rooftop Mixer (https://lu.ma/roof)", object_key: "https://lu.ma/roof", url: "https://lu.ma/roof", kind: "event", when: "2026-08-20", happened_at: long }],
      offers: [{ match: { name: "Founder Dinner", url: "https://lu.ma/fd", event_api_id: "evt-1", event_date: "2026-08-02", tier: 1 }, at: long }],
      revealed: [{ item_key: "name:ycombinator s27", item_name: "YC S27", kind: "opportunity", url: "https://yc.com/s27", sent_at: long, reaction: "interested" }],
      acts: [{ object_label: "x", meta: { ledger: 1, kind: "find", groups: [["u:https://lu.ma/only-ledger", "n:only ledger"]] }, happened_at: long }],
    },
    other: { offers: [{ match: { name: "Secret Thing", url: "https://lu.ma/secret", event_api_id: "evt-77", tier: 1 }, at: NOW }] },
  };
  const seen: string[] = [];
  const mine = await sentByReferent(fakeQ(db, seen), "me");
  check("a find sent 100+ days ago is still caught (offer)", wasSent(mine, { name: "Founder Dinner", eventId: "evt-1" }));
  check("a find sent 100+ days ago is still caught (action record, by link variant)", wasSent(mine, { name: "Rooftop Mixer night", url: "https://luma.com/roof" }));
  check("a find sent 100+ days ago is still caught (send ledger, by name)", wasSent(mine, { name: "YC S27" }));
  check("the action ledger answers by link", wasSent(mine, { name: "Whatever", url: "https://luma.com/only-ledger" }));
  check("the action ledger never folds a recurrence in by name", !wasSent(mine, { name: "only ledger", ident: { event_date: "2026-11-30" } }));
  check("every query binds the member as $1", seen.length === 4 && seen.every((s) => s === "me|true"), seen);
  check("another member's sends never count", !wasSent(mine, { name: "Secret Thing", url: "https://lu.ma/secret", eventId: "evt-77" }));
  const theirs = await sentByReferent(fakeQ(db), "other");
  check("and a member sees only their own", theirs.length === 1 && !wasSent(theirs, { name: "Founder Dinner" }));
  check("a member with nothing sent has an empty record", (await sentByReferent(fakeQ(db), "nobody")).length === 0);
  check("a failing source throws (never a quietly shorter list)", await sentByReferent(async () => { throw new Error("db down"); }, "me").then(() => false, () => true));

  // ---------------------------------------------------------------- the picker's pool
  const raw = (name: string, url: string, id: string | null, date: string | null) => ({ name, date, tier: 1, askId: "a1", fromProfile: false, reminder: false, details: null, ident: { name, url, event_api_id: id, event_date: date } });
  const ask = new Map([["a1", "1"]]);
  const pool = buildShadowPool(
    [raw("Dinner for Founders", "https://luma.com/fd?ref=sms", null, null), raw("Rooftop Mixer", "https://lu.ma/roof", "evt-5", null), raw("Rooftop Mixer (Dec)", "https://lu.ma/roof", "evt-5", "2026-12-02"), raw("Founder Dinner", "https://lu.ma/fd-dec", "evt-9", "2026-12-14"), raw("Poker Night", "https://lu.ma/poker", "evt-6", "2026-12-03")],
    "2026-11-06", ask, new Set(), new Set(), new Set(), [], mine,
  );
  const names = pool.map((p) => p.name);
  check("pool: the same link under another name is left out", !names.includes("Dinner for Founders"), names);
  check("pool: a sent link under a new id is left out", !names.includes("Rooftop Mixer"), names);
  check("pool: a sent link whose record says another date (a listing, a group page) stays", names.includes("Rooftop Mixer (Dec)"), names);
  check("pool: a recurring event with a new id and date stays", names.includes("Founder Dinner"), names);
  check("pool: a new find stays", names.includes("Poker Night"), names);
  const rem = buildShadowPool([{ ...raw("Rooftop Mixer", "https://lu.ma/roof", "evt-5", "2026-12-02"), reminder: true }], "2026-11-06", ask, new Set(), new Set(), new Set(), [], mine);
  check("pool: a reminder of a sent find still stays", rem.length === 1);
}

// ---------------------------------------------------------------- the delivered merge
{
  const sentItem = (name: string, key: string, url: string | null, at: string, date: string) => ({ key, name, kind: "event" as const, url, sentAt: new Date(at), reaction: null, details: null, postText: null, endsOn: date });
  const d = mergeDelivered({
    ledger: [{ label: "the link to Run Club (https://lu.ma/rc1)", url: "https://lu.ma/rc1", kind: "event", at: new Date("2026-10-01T00:00:00Z") }],
    offers: [sentItem("Run Club", "event:rc1", "https://luma.com/rc1", "2026-10-01T00:01:00Z", "2026-10-05"), sentItem("Run Club", "event:rc2", "https://lu.ma/rc2", "2026-10-20T00:00:00Z", "2026-10-26")],
  });
  check("delivered: the same link in the ledger and an offer is one entry", d.filter((x) => x.url?.includes("rc1")).length === 1 && d.find((x) => x.url?.includes("rc1"))!.via.length === 2, d);
  check("delivered: a recurring event is its own entry", d.length === 2, d.map((x) => x.what));
}

console.log(`\n${total - failed}/${total} passed`);
if (failed) process.exit(1);
