// A waitlisted event is offered as waitlist only, never turned away as sold out (Royce, 2026-11-10). Its Luma page says registration
// "waitlist" (and sold_out true, as Luma marks a waitlist): it's kept, carries the label, and never says or hints at spots. Full with
// no waitlist ("sold-out") is still turned away; approval-required is as it was. Zero tokens: pages are fixtures, nothing is fetched.
//   npx tsx evals/search/waitlistOnly.ts
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";

const E = await import("../../src/services/eventDetails.js");
const SC = await import("../../src/services/sendCheck.js");
const MG = await import("../../src/harness/matchGate.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};

const start = new Date(Date.now() + 48 * 3_600_000).toISOString();
// A Luma event page as served (__NEXT_DATA__), with its registration state and flags.
const page = (o: { registration: string; soldOut: boolean; spots: number | null; approval?: boolean }) => {
  const data = {
    event: { api_id: "evt-w", url: "w1", name: "Founders Supper", start_at: start, end_at: null, timezone: "America/Los_Angeles", visibility: "public", location_type: "offline", geo_address_visibility: "public", geo_address_info: { city: "San Francisco", address: "Pier 1", full_address: "Pier 1, San Francisco, CA" } },
    hosts: [{ name: "A Host" }], guest_count: 40, sold_out: o.soldOut, registration_availability: o.registration,
    ticket_info: { is_free: true, price: null, is_sold_out: false, spots_remaining: o.spots, require_approval: o.approval ?? false },
  };
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { data } } } })}</script></body></html>`;
};
const asMatch = (d: import("../../src/services/eventDetails.js").EventDetails) => ({ tier: 2, kind: "public_event", event_api_id: "evt-w", event_date: start.slice(0, 10), name: "Founders Supper", url: "https://lu.ma/w1", reason: "x", details: d }) as any;

// ---------------------------------------------------------------- 1. a waitlist event is kept and carries the label
const wait = E.parseLumaEventPage(page({ registration: "waitlist", soldOut: true, spots: 0 }))!;
check("a waitlist page: waitlist only, not sold out", wait.waitlist === true && wait.soldOut === false && wait.registration === "waitlist", wait);
check("the gate keeps it (available), saying why", MG.checkAvailable(asMatch(wait)).pass === true && MG.checkAvailable(asMatch(wait)).reason === "waitlist only", MG.checkAvailable(asMatch(wait)));
const lines = E.renderEventDetails("Founders Supper", wait);
check("its facts carry the waitlist-only line", lines.includes(E.WAITLIST_FACT), lines);
check("...and never a spots count or 'sold out' beside it", !lines.some((l) => /spots left|sold out/i.test(l)), lines);
const re = await SC.recheckFind(asMatch(wait), { now: new Date(), zone: "America/Los_Angeles", deps: { luma: async () => wait, page: async () => ({ text: null, gone: false }) } });
check("the send-time re-read keeps it (0 spots with a waitlist is not 'no spots left')", re.ok === true, re);
const wasOpen = { ...wait, waitlist: undefined, soldOut: false, spotsRemaining: 5, registration: "open" };
const turned = await SC.recheckFind(asMatch(wasOpen), { now: new Date(), zone: "America/Los_Angeles", deps: { luma: async () => wait, page: async () => ({ text: null, gone: false }) } });
check("found open, waitlist only at send time: kept, and the change says so", turned.ok === true && (turned as any).changed.includes(`now ${E.WAITLIST_SHORT}`), turned);
check("a re-read find's facts say waitlist only, no spots", SC.onFileFacts(asMatch(wait), new Date().toISOString()).includes(E.WAITLIST_SHORT) && !SC.onFileFacts(asMatch(wait), new Date().toISOString()).some((f) => /spots left/.test(f)));

// ---------------------------------------------------------------- 2. sold out with no waitlist is still dropped
const sold = E.parseLumaEventPage(page({ registration: "sold-out", soldOut: true, spots: 0 }))!;
check("a sold-out page (no waitlist): sold out, no waitlist", sold.soldOut === true && !sold.waitlist, sold);
check("the gate still turns it away", MG.checkAvailable(asMatch(sold)).pass === false, MG.checkAvailable(asMatch(sold)));
const reSold = await SC.recheckFind(asMatch(sold), { now: new Date(), zone: "America/Los_Angeles", deps: { luma: async () => sold, page: async () => ({ text: null, gone: false }) } });
check("the send-time re-read exits it as sold out", reSold.ok === false && (reSold as any).exit === true, reSold);
const zero = { ...E.parseLumaEventPage(page({ registration: "open", soldOut: false, spots: 0 }))! };
const reZero = await SC.recheckFind(asMatch(zero), { now: new Date(), zone: "America/Los_Angeles", deps: { luma: async () => zero, page: async () => ({ text: null, gone: false }) } });
check("0 spots and no waitlist: still 'no spots left' (exits)", reZero.ok === false && /no spots left/.test((reZero as any).why), reZero);

// ---------------------------------------------------------------- 3. approval-required is as it was
const appr = E.parseLumaEventPage(page({ registration: "open", soldOut: false, spots: 12, approval: true }))!;
check("approval required: kept, no waitlist label, approval line and spots as before", MG.checkAvailable(asMatch(appr)).pass === true && MG.checkAvailable(asMatch(appr)).reason === "needs host approval" && !appr.waitlist && E.renderEventDetails("Founders Supper", appr).includes("Registration needs host approval.") && E.renderEventDetails("Founders Supper", appr).includes("12 spots left."));

// ---------------------------------------------------------------- 4. the caption check refuses spots for a waitlist event
const facts = lines.join(" ");
const refused = (c: string) => !SC.captionNumbersBacked(c, facts).ok;
for (const c of ["Spots are still open if you want in.", "There are still spots, grab one.", "Registration is still open.", "Only a few spots left.", "Not sold out yet.", "You can still register for it.",
  // Review of #452: a waitlist phrase never hides a spots claim.
  "Open spots on the waitlist.", "You can register now, spots are open for the waitlist crowd.",
  // Final review of #452: room left as a number.
  "Get on the waitlist, there's room for 20 more.", "Join the waitlist, 15 more can get in.", "Waitlist's moving, 5 seats just freed up."]) check(`waitlist event: refused "${c}"`, refused(c), SC.captionNumbersBacked(c, facts));
for (const c of ["I can get you off the waitlist.", "I can get you a spot."]) check(`waitlist event: refused "${c}" (Cue only adds them to the waitlist)`, refused(c), SC.captionNumbersBacked(c, facts));
for (const c of ["Founders Supper on Thursday. It's waitlist only, so joining puts you on the list, not in.", "A small founders dinner at Pier 1. Full, but there's a waitlist.",
  // Review of #452: joining the waitlist, and the venue's room or space, are not spots.
  "You can register for the waitlist on the page.", "You can sign up for the waitlist.", "Registration is open for the waitlist.", "Great space available for demos at the venue.", "Plenty of room to breathe at this one, it's outdoors.", "Waitlist only, and it's a 20-minute walk from BART."]) check(`waitlist event: an honest caption passes "${c}"`, !refused(c), SC.captionNumbersBacked(c, facts));
check("an open event's caption is unchanged by this rule (\"spots are still open\" with spots on its page)", SC.captionNumbersBacked("Spots are still open.", E.renderEventDetails("Founders Supper", appr).join(" ")).ok, SC.captionNumbersBacked("Spots are still open.", E.renderEventDetails("Founders Supper", appr).join(" ")));

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
