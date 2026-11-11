// A web page that lists several events is not one of them (2026-11-11). Synthetic pages only; zero tokens, fake page reads.
//   npx tsx evals/opportunity/roundupPage.ts
// The failure it guards: a blog post covering three founder events in one week was read as one event's own page, because the page
// reader returns most web pages as one flat run of text, and a flat page "names the thing in its first line" whenever it names it at
// all. The post's link went out as the dinner, with "host approval needed so worth applying now" said from the blog, not the event.
import { recheckFind, roundupOf, type RecheckDeps } from "../../src/services/sendCheck.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
  }
};

// Invented community, hosts and venues; the shape matches the reported page (a flat blog post), never its content.
const DINNER = "Harbor Builders: A Small Monthly Founder Dinner";
const FLAT_BLOG =
  "East Bay Founder Events November 2026 | Harbor Notes Skip to Content Home About Blog Events " +
  "East Bay Founder Events in November 2026: Where to Meet Other Builders. Written by the Harbor team. " +
  "If you build startups in the East Bay, the next few days are full. Our calendar currently lists three founder events this week, " +
  "covering a go-to-market talk, a small founder dinner and a games night. Each has a different format. " +
  `Go-to-market evening: Wed, Nov 11, 6:00 PM. ${DINNER}: Location TBD, Thu, Nov 12, 5:30 PM. Games night: Fri, Nov 13, 6:00 PM. ` +
  "Two of the three need host approval to attend. The dinner is for 15 to 20 founders, no fee; guests cover their own food.";
const FLAT_OWN_PAGE =
  `${DINNER} · Event Page Thu, Nov 12, 5:30 PM. A seated dinner for 15 to 20 founders, two long tables. ` +
  "Hosts pick guests for a mix of technical and business founders. Registration requires host approval.";
const LINED_OWN_PAGE = `${DINNER}\nThe second of two dinners this month.\nA seated dinner for 15 to 20 founders.`;

{
  const r = roundupOf(FLAT_BLOG, DINNER, { page: true });
  check("a flat blog page counting the events it covers is a roundup", !!r, r);
  check("its own flat page (title names it) is not a roundup", roundupOf(FLAT_OWN_PAGE, DINNER, { page: true }) === null);
  check("its own page with lines, mentioning 'two dinners', is not a roundup (first line names it)", roundupOf(LINED_OWN_PAGE, DINNER, { page: true }) === null);
  check("a page that never names it is never its roundup", roundupOf("Weekend notes | Harbor. Five events this week.", DINNER, { page: true }) === null);
  // Posts (X) keep the first-line rule.
  check("a post whose first line names it is still not a roundup", roundupOf(`${DINNER} is on Thursday\n- seated\n- 15 to 20 founders\n- host approval`, DINNER) === null);
}

{
  const pages: Record<string, { text: string | null; gone: boolean }> = { "https://harbornotes.example/blog/east-bay-founder-events": { text: FLAT_BLOG, gone: false } };
  const deps = { luma: async () => null, page: async (u: string) => pages[u] ?? { text: null, gone: false }, sentNames: async () => [], discussedAmong: async () => new Set<string>() } as unknown as RecheckDeps;
  const now = new Date("2026-11-11T16:00:00Z");
  const match: any = {
    tier: 3, kind: "opportunity", name: DINNER, url: "https://harbornotes.example/blog/east-bay-founder-events", source: "web",
    reason: "capacity: 15 to 20 founders; price: no fee; approval: registration subject to host approval; date: 2026-11-12",
    opportunity: { postText: `${DINNER}. capacity: 15 to 20 founders; approval: registration subject to host approval; date: 2026-11-12` },
    statedDates: { start: "2026-11-12" },
  };
  const r = await recheckFind(match, { now, zone: "America/Los_Angeles", deps });
  check("the blog is never sent as the dinner's own page: held (no page of its own reads, and the flat post lists no places to share as a list)", !r.ok && (r as any).exit === false && /listing several things/.test((r as any).why), r);
}

console.log(`\nroundup page: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
