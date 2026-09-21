// Jev vs the current Sonnet judge on "does this event fit what they asked for"
// (services/tieredRecommendation.ts isGenuinelyRelevant). Invented, hand-labelled
// cases only: no member data is sent to TypeSafe.
//   railway run --service co-test --environment dev -- npx tsx evals/jev/relevanceCompare.ts
// (or set the key in api/.env). Live model calls; costs a few cents.
import "dotenv/config";
import { isGenuinelyRelevant } from "../../src/services/tieredRecommendation.js";
import { jevRelevance } from "../../src/services/jevClassifiers.js";
import { jevAvailable } from "../../src/services/jev.js";

type Case = { id: string; ask: string; name: string; description: string; expectFit: boolean };
const C = (id: string, ask: string, name: string, description: string, expectFit: boolean): Case => ({ id, ask, name, description, expectFit });

const cases: Case[] = [
  C("chess_real", "chess night", "SF Chess Social", "Casual chess night open to all levels. Bring a board or use ours. Beer and snacks provided. No tournament, just chess and conversation.", true),
  C("chess_rooftop", "chess night", "Rooftop Chess & Cocktails", "Weekly chess on a rooftop bar. Boards provided, all levels, first drink on us for new players.", true),
  C("chess_vs_pitch", "chess night", "Founders & Builders Pitch Night", "Join fellow founders and builders for an evening of 2-minute pitches, feedback, and networking over drinks. Bring your deck or just come to watch.", false),
  C("chess_sponsored", "chess night", "Stripe Community Chess Night", "Hosted at Stripe's SF office. An evening of casual chess with boards for everyone, pizza provided. Open to the public, all skill levels.", true),
  C("pottery_wheel", "pottery class", "Beginner Wheel Throwing Workshop", "Learn to center clay and throw your first bowl in this hands-on two-hour studio class. All materials included.", true),
  C("pottery_vs_mixer", "pottery class", "Builder Community Mixer", "A casual mixer for founders, engineers, and builders in SF to meet each other, swap notes, and make new connections in the startup scene.", false),
  C("pottery_vs_painting", "pottery class", "Wine & Watercolor Night", "Paint a watercolor landscape while sipping wine. No experience needed, all supplies provided.", false),
  C("run_club", "run club", "Saturday Morning 5K Run Club", "Meet at the Ferry Building for an easy-paced 5K along the Embarcadero, all paces welcome, coffee after.", true),
  C("run_vs_bakery", "run club", "Bakery Crawl & Coffee", "Walk between four neighborhood bakeries tasting pastries with a local food writer.", false),
  C("pickle_real", "pickleball", "Pickleball for Beginners", "Learn the rules and rally with other new players. Paddles provided, courts at Dolores Park.", true),
  C("pickle_vs_tennis", "pickleball", "Tennis Ladder Kickoff", "Season kickoff for the SF tennis ladder. Singles matches scheduled among registered players.", false),
  C("yoga_real", "yoga", "Sunset Yoga in the Park", "Gentle vinyasa flow on the lawn at Crissy Field. Bring a mat. Donation-based.", true),
  C("yoga_vs_panel", "yoga", "Wellness Founders Panel", "Founders of three wellness startups discuss building in the health space, followed by networking.", false),
  C("hike_real", "hiking", "Marin Headlands Sunday Hike", "Moderate 6-mile group hike with ocean views. Meet at the trailhead, carpool from the Presidio.", true),
  C("hike_vs_climb", "hiking", "Indoor Rock Climbing Intro", "First-timer climbing session at the gym. Shoes and harness rental included, instructor-led.", false),
  C("book_real", "book club", "Sci-Fi Book Club", "Monthly discussion of a science fiction novel at a cafe in the Mission. This month: a classic time-travel story.", true),
  C("lang_real", "language exchange", "Spanish Conversation Meetup", "Practice Spanish with native and learner speakers over drinks. Casual, all levels.", true),
  C("lang_vs_cooking", "language exchange", "Paella Cooking Class", "Learn to cook a traditional Valencian paella with a chef. Ingredients included.", false),
  C("founder_demo", "founder meetup", "Side-Project Demo Night", "Founders and builders show off what they've been working on this month. Short demos, no slides required, just show your screen.", true),
  C("founder_pitch", "founder meetup", "Hardware Pitch Night", "Hardware founders pitch their startups to a room of other builders and a few investors. Q&A after each pitch, drinks and mingling to follow.", true),
  C("founder_fireside", "founder meetup", "Founders' Fireside: Fundraising in a Down Market", "Small-room conversation where seed and Series A founders trade honest stories about raising this year. 30 seats, dinner included.", true),
  C("founder_vs_hackathon", "founder meetup", "AI Engineers Hack Weekend", "Two days of building with new AI APIs. Form a team Saturday morning, demo Sunday afternoon, prizes for the top three projects.", false),
  C("founder_vs_summit", "founder meetup", "Global Startup Summit 2026", "5,000 attendees, 200 speakers across six stages, expo hall, keynotes, and a ticketed after-party.", false),
  C("founder_vs_wine", "founder meetup", "Wine & Cheese Evening, Sponsored by Google Cloud", "An evening of wine and cheese pairings from Northern California producers. Sponsored by Google Cloud.", false),
  C("builder_open", "builder community", "Open Build Night", "Bring your laptop or your project and work alongside other makers. No talks, just heads-down building and conversation.", true),
  C("ai_talks", "AI meetup", "Multi-Agent Systems: Lightning Talks", "Five short talks from engineers building multi-agent systems in production, then open discussion.", true),
  C("ai_vs_baking", "AI meetup", "Sourdough Baking Social", "Bring a starter and swap tips with fellow home bakers. Bread tasting at the end.", false),
  C("design_meetup", "design community", "Designers Who Code: Monthly Meetup", "Product designers who also write code share what they're shipping. Lightning demos and open networking.", true),
  C("design_vs_k8s", "design community", "Kubernetes Deep Dive", "A technical evening on scaling stateful workloads on Kubernetes, aimed at platform engineers.", false),
  C("climate_dinner", "climate tech", "Climate Tech Founders Dinner", "Intimate dinner for founders building in climate technology: energy, carbon, and industrial decarbonization.", true),
  C("climate_vs_generic", "climate tech", "Founders Dinner", "A dinner for early-stage founders across industries to meet and share what they're working on.", false),
  C("investor_hours", "meet angel investors", "Angel Investor Office Hours", "Book a 15-minute slot with active angel investors to get feedback on your pre-seed pitch.", true),
  C("investor_vs_wine", "meet angel investors", "Sunset Wine Tasting", "Taste five California red wines at a hillside vineyard with a sommelier.", false),
];

const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7];

async function main() {
  if (!jevAvailable()) {
    console.log("No Jev key in this environment. Run through `railway run` or set it in api/.env.");
    process.exit(2);
  }
  const rows: { c: Case; sonnet: boolean; sonnetMs: number; p: number | null; jevMs: number | null }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const c = cases[next++];
      const t0 = Date.now();
      const s = await isGenuinelyRelevant(c.ask, c.name, "San Francisco", c.description);
      const sonnetMs = Date.now() - t0;
      const j = await jevRelevance(c.ask, c.name, "San Francisco", c.description);
      rows.push({ c, sonnet: s.fit, sonnetMs, p: j?.p ?? null, jevMs: j?.ms ?? null });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  rows.sort((a, b) => cases.indexOf(a.c) - cases.indexOf(b.c));

  const ok = rows.filter((r) => r.p !== null);
  const acc = (f: (r: (typeof rows)[number]) => boolean) => `${ok.filter((r) => f(r) === r.c.expectFit).length}/${ok.length}`;
  console.log(`\n${cases.length} labelled cases, ${ok.length} answered by Jev\n`);
  console.log("case".padEnd(22), "want", "sonnet", "jev p ", "");
  for (const r of rows) {
    const jevYes = r.p !== null && r.p >= 0.5;
    const flag = (r.sonnet !== r.c.expectFit ? " SONNET-WRONG" : "") + (r.p !== null && jevYes !== r.c.expectFit ? " JEV-WRONG" : "");
    console.log(r.c.id.padEnd(22), String(r.c.expectFit).padEnd(5), String(r.sonnet).padEnd(6), r.p === null ? "none " : r.p.toFixed(2), flag);
  }
  console.log(`\naccuracy  Sonnet: ${acc((r) => r.sonnet)}   Jev@0.5: ${acc((r) => (r.p ?? 0) >= 0.5)}`);
  for (const t of THRESHOLDS) console.log(`  Jev @${t}: ${acc((r) => (r.p ?? 0) >= t)}`);
  const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`\nmedian latency  Sonnet: ${med(rows.map((r) => r.sonnetMs))}ms   Jev: ${med(ok.map((r) => r.jevMs!))}ms`);
  const sure = ok.filter((r) => r.p! <= 0.15 || r.p! >= 0.85).length;
  console.log(`Jev confident (<=0.15 or >=0.85): ${sure}/${ok.length}`);
  process.exit(0);
}
main();
