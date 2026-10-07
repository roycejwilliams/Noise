// Round 2 of the browser pilot (Royce, 2026-10-07): the general SDK reader (services/sdkGeneralReader.ts) on sites Co has NO
// script for, chosen for quality (rooms and venues Co would actually put in front of a member). The claim under test:
// trustworthy answers where the alternative is nothing. Scored per field against answers checked by hand on 2026-10-07:
//   right / unknown (said it didn't know) / WRONG (a confident answer that isn't true). Cost per task is reported, not judged.
// Metered, with a hard stop before the pilot cap's remaining $7.46:
//   EVAL_REAL_MODELS=1 EVAL_COST_CAP_USD=7.46 EVAL_TOKEN_CAP=20000000 npm run eval:live -- evals/browserPilot/round2.ts
// Booking, buying, RSVPs and sign-ins can't happen: the reader is read-only at the network (GET/HEAD only).
import "../lib/requireMeter.js";
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const G = await import("../../src/services/sdkGeneralReader.js");
const R = await import("../../src/services/browserRead.js");

type Truth = { right: RegExp; unknownOk?: boolean; note: string };
type Case = { id: string; kind: "event" | "venue" | "listing"; url: string; fields: { key: string; ask: string }[]; truth: Record<string, Truth>; validUntil?: string };
// The answers were checked by hand on this day. An event case is good until its date; a venue or listing for 30 days.
export const TRUTH_CHECKED = "2026-10-07";
const plusDays = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
export const VENUE_TRUTH_DAYS = 30;

const EVENT_FIELDS = [
  { key: "date", ask: "the date it happens" },
  { key: "start_time", ask: "the time the program or event starts (not doors, if both are given)" },
  { key: "price", ask: "the standard price for a non-member to attend in person, as stated (or free)" },
  { key: "where", ask: "where it happens in person: venue name or street address (or 'online only' if the page says so)" },
  { key: "sold_out", ask: "is it sold out? yes or no, only if the page says" },
];
const LISTING_FIELDS = [
  { key: "hourly_price", ask: "the listed hourly rental rate" },
  { key: "minimum_hours", ask: "the minimum booking length in hours" },
  { key: "capacity", ask: "the maximum number of attendees" },
];
const VENUE_FIELDS = [
  { key: "capacity", ask: "the largest group it can host for a private event (headcount as stated)" },
  { key: "pricing", ask: "any stated price, rate, minimum spend or cost example for a private event" },
  { key: "inquire", ask: "how to inquire about a private event: the email address, phone, or the inquiry form's page" },
];
const notSoldOut: Truth = { right: /^no\b/i, unknownOk: true, note: "on sale on 10-07; no sold-out notice" };

export const CASES: Case[] = [
  { id: "cc-roose", kind: "event", validUntil: "2026-10-19", url: "https://www.commonwealthclub.org/events/2026-10-19/kevin-roose-inside-race-create-artificial-superintelligence", fields: EVENT_FIELDS, truth: {
    date: { right: /oct(ober)?\.? 19|10\/19/i, note: "Mon, Oct 19" }, start_time: { right: /\b6(:00)?\s*(p\.?m)/i, note: "6:00 PM (doors 5:30)" },
    price: { right: /\$25\b/, note: "$25 in person ($58 with book; $10 online)" }, where: { right: /110 the embarcadero|commonwealth club/i, note: "110 The Embarcadero" }, sold_out: notSoldOut } },
  { id: "cc-bash", kind: "event", validUntil: "2026-10-14", url: "https://www.commonwealthclub.org/events/2026-10-14/dana-bash-elections-changed-world", fields: EVENT_FIELDS, truth: {
    date: { right: /oct(ober)?\.? 14|10\/14/i, note: "Wed, Oct 14" }, start_time: { right: /\b12(:00)?\s*(p\.?m)|noon/i, note: "12:00 PM" },
    price: { right: /\$10\b|online/i, unknownOk: true, note: "$10, online only (no in-person price exists)" }, where: { right: /online/i, note: "online only" }, sold_out: notSoldOut } },
  { id: "sfmoma-aitken", kind: "event", validUntil: "2026-10-29", url: "https://www.sfmoma.org/event/an-evening-with-doug-aitken/", fields: EVENT_FIELDS, truth: {
    date: { right: /oct(ober)?\.? 29|10\/29/i, note: "Thu, Oct 29" }, start_time: { right: /\b6(:00)?\s*(p\.?m)/i, note: "6 p.m." },
    price: { right: /\$0|free|\$10\b/i, note: "tiered: $0 free RSVP, $10 general, $20, $30" }, where: { right: /wattis|sfmoma/i, note: "Floor 1, Phyllis Wattis Theater" }, sold_out: notSoldOut } },
  { id: "sfmoma-rooftop", kind: "event", validUntil: "2026-10-15", url: "https://www.sfmoma.org/event/rooftop-radio-k-pop/", fields: EVENT_FIELDS, truth: {
    date: { right: /oct(ober)?\.? 15|10\/15/i, note: "Thu, Oct 15" }, start_time: { right: /\b5:30\s*(p\.?m)?/i, note: "5:30 p.m. (doors 5)" },
    price: { right: /\$35\b/, note: "$35 ($15 members)" }, where: { right: /sfmoma|rooftop|museum|sculpture garden|floor 5/i, note: "SFMOMA, Floor 5 sculpture garden (rooftop)" }, sold_out: notSoldOut } },
  { id: "longnow-thurston", kind: "event", validUntil: "2026-10-22", url: "https://longnow.org/talks/02026-thurston-aguera-y-arcas/", fields: EVENT_FIELDS, truth: {
    date: { right: /oct(ober)?\.? 22|10\/22/i, note: "Thu, Oct 22" }, start_time: { right: /\b7(:00)?\s*(p\.?m)/i, note: "7:00 PM PT" },
    price: { right: /^$/, unknownOk: true, note: "not on longnow.org (tickets on another site): only unknown is right" }, where: { right: /cowell|fort mason/i, note: "Cowell Theater, Fort Mason Center" }, sold_out: notSoldOut } },
  { id: "eb-portfolio", kind: "event", validUntil: "2026-10-22", url: "https://www.eventbrite.com/e/portfolio-night-2026-san-francisco-tickets-1995718066460", fields: EVENT_FIELDS, truth: {
    date: { right: /oct(ober)?\.? 22|10\/22/i, note: "Thu, Oct 22" }, start_time: { right: /\b5:30\s*(p\.?m)?/i, note: "5:30 PM" },
    price: { right: /\$25\b/, note: "$25 (ticket panel)" }, where: { right: /45 fremont/i, note: "45 Fremont Street" }, sold_out: notSoldOut } },
  { id: "eb-startup-oasis", kind: "event", validUntil: "2026-10-16", url: "https://www.eventbrite.com/e/find-a-cofounder-help-or-join-a-startup-tickets-2000902615586", fields: EVENT_FIELDS, truth: {
    date: { right: /oct(ober)?\.? 16|10\/16/i, note: "Fri, Oct 16" }, start_time: { right: /\b(6|7)(:00)?\s*(p\.?m)/i, note: "listed 6 PM; doors+networking 6:00, program (\"Startup Oasis Begins\") 7:00: either answers it" },
    price: { right: /free|\$0/i, note: "free (donations welcome)" }, where: { right: /frontier tower|995 market/i, note: "Frontier Tower, 995 Market St" }, sold_out: notSoldOut } },
  { id: "gg-clarion", kind: "listing", url: "https://giggster.com/listing/sf-chinatown-multiuse-venue", fields: LISTING_FIELDS, truth: {
    hourly_price: { right: /\$225\b/, note: "$225/hr (add-ons $80-$180/hr are not the rate)" }, minimum_hours: { right: /^\D*2\b/, note: "2 hr" }, capacity: { right: /\b60\b/, note: "60 people" } } },
  { id: "gg-eastcut", kind: "listing", url: "https://giggster.com/listing/elegant-bay-bridge-offsite-space", fields: LISTING_FIELDS, truth: {
    hourly_price: { right: /\$175\b/, note: "$175/hr" }, minimum_hours: { right: /^\D*3\b/, note: "3 hr" }, capacity: { right: /\b30\b/, note: "30 max attendees (22 standing / 22 seated)" } } },
  { id: "foreign-cinema", kind: "venue", url: "https://www.foreigncinema.com/", fields: VENUE_FIELDS, truth: {
    capacity: { right: /\b350\b/, note: "up to 350 guests (rooms 12-166 seated)" }, pricing: { right: /^$/, unknownOk: true, note: "no price on the site: only unknown is right" },
    inquire: { right: /janine@|info@|648\.7600|648-7600|form|inquire/i, note: "form, janine@ / info@foreigncinema.com, 415.648.7600 ext. 2" } } },
  { id: "the-interval", kind: "venue", url: "https://theinterval.org/", fields: VENUE_FIELDS, truth: {
    capacity: { right: /\b75\b|\b49\b/, note: "49 indoors, 75 with outdoor space" }, pricing: { right: /2,?000|12,?000/, note: "under $2,000 (49 ppl, 2h day) to over $12,000 (75 ppl, 5h evening)" },
    inquire: { right: /interval\/book|form/i, note: "the form at longnow.org/interval/book/" } } },
  { id: "the-midway", kind: "venue", url: "https://www.themidwaysf.com/", fields: VENUE_FIELDS, truth: {
    capacity: { right: /1,?500|1,?000/, note: "50 to 1,500+ guests (corporate site); 888 Garage 1,000" }, pricing: { right: /^$/, unknownOk: true, note: "no price on the site: only unknown is right" },
    inquire: { right: /corporate|form|@themidwaysf|venue-rental/i, note: "corporate bookings site / its form" } } },
];

export function scoreField(value: string | null, t: Truth): "right" | "unknown" | "WRONG" {
  if (value === null) return "unknown";
  return t.right.test(value) ? "right" : "WRONG";
}

const PRICE = { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 }; // Haiku 5.5, per million
const cost = (u: { input: number; output: number; cacheRead: number; cacheWrite: number }) => (u.input * PRICE.input + u.output * PRICE.output + u.cacheRead * PRICE.cacheRead + u.cacheWrite * PRICE.cacheWrite) / 1e6;
const CAP = 7.46;

const only = process.env.ROUND2_ONLY ? process.env.ROUND2_ONLY.split(",") : null;
// The standing eval (Royce, 2026-10-07): any change to readers or extraction re-runs this, and a regression fails like a test.
//   - any confident-wrong answer fails, always (one wrong find costs more trust than ten missing ones);
//   - right answers more than ROUND2_SLACK below the hand-checked baseline (baseline.json) fail;
//   - a case past its truth date is skipped; under MIN_VALID cases left, it fails until the truth is re-checked by hand.
export const MIN_VALID = 8;
const ROUND2_SLACK = 2;
const today = (process.env.ROUND2_TODAY ?? new Date().toISOString()).slice(0, 10);
const validUntil = (c: Case) => c.validUntil ?? plusDays(TRUTH_CHECKED, VENUE_TRUTH_DAYS);
const expired = CASES.filter((c) => validUntil(c) < today).map((c) => c.id);
if (expired.length) console.log(`skipped (truth past its date, re-check by hand): ${expired.join(", ")}`);
const out: any[] = [];
let total = 0;
const tally = { right: 0, unknown: 0, WRONG: 0 };
for (const c of CASES.filter((x) => (!only || only.includes(x.id)) && !expired.includes(x.id))) {
  if (total > CAP - 0.5) {
    console.log(`ROUND 2 STOPPED: spend $${total.toFixed(4)} is within $0.50 of the $${CAP} left`);
    break;
  }
  const r = await G.readWithSdk(c.url, c.fields);
  const usd = cost(r.usage);
  total += usd;
  const scored = c.fields.map((f) => {
    const a = r.answers[f.key];
    const s = scoreField(a.value, c.truth[f.key]);
    tally[s]++;
    return { key: f.key, value: a.value, evidence: a.evidence, score: s, truth: c.truth[f.key].note, unknownOk: !!c.truth[f.key].unknownOk };
  });
  out.push({ id: c.id, url: c.url, usd, turns: r.turns, ms: r.ms, stopped: r.stopped, dropped: r.dropped, usage: r.usage, trace: r.trace, scored });
  console.log(`\n${c.id}  $${usd.toFixed(4)}  ${r.turns} turns  ${(r.ms / 1000).toFixed(0)}s${r.stopped ? `  STOPPED ${r.stopped}` : ""}${r.dropped.length ? `  dropped(no evidence): ${r.dropped.join(",")}` : ""}`);
  for (const s of scored) console.log(`  ${s.score.padEnd(7)} ${s.key.padEnd(13)} ${JSON.stringify(s.value)}  [truth: ${s.truth}]`);
  console.log(`  trace: ${r.trace.join(" > ")}`);
}
mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
const file = new URL(`./results/round2-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
writeFileSync(file, JSON.stringify({ total, tally, cases: out }, null, 2));
console.log(`\nROUND 2: ${tally.right} right, ${tally.unknown} unknown, ${tally.WRONG} WRONG | spend $${total.toFixed(4)} over ${out.length} tasks ($${(total / Math.max(1, out.length)).toFixed(4)}/task) -> ${file.pathname}`);
await R.closeBrowser();
const baseline = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8")) as { checked: string; right: Record<string, number> };
const ran = out.map((c) => c.id);
const expect = ran.reduce((n, id) => n + (baseline.right[id] ?? 0), 0);
const failures: string[] = [];
if (tally.WRONG > 0) failures.push(`${tally.WRONG} confident-wrong answer${tally.WRONG === 1 ? "" : "s"}`);
if (!only && tally.right < expect - ROUND2_SLACK) failures.push(`${tally.right} right vs ${expect} at baseline (more than ${ROUND2_SLACK} fewer)`);
if (!only && ran.length < MIN_VALID) failures.push(`only ${ran.length} cases still have current truth: re-check the answers by hand and update round2.ts + baseline.json`);
if (failures.length) {
  console.log(`ROUND 2 GATE FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`ROUND 2 GATE PASSED (${ran.length} cases, baseline ${expect} right)`);
