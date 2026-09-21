// Blind accuracy test: Claude's event-fit check against Jev, on cases labelled BEFORE
// either model was run (2026-09-21). Invented cases only, so no member data leaves
// the machine. Optionally add real ask/event pairs in evals/jev/blind.local.json
// (git-ignored: it holds member asks) as [{ask, name, description, label}].
//
//   railway run --service co-test --environment dev -- npx tsx evals/jev/relevanceBlind.ts
//
// Result on the day: 97 cases (57 real in-window pairs + these 40), Claude 84%, Jev
// 92% at a 0.5 cutoff; where they disagreed Jev was right 11 times to Claude's 3.
// Claude's mistakes were nearly all false yeses (hackathons, conferences, a private
// offsite); a 0.45 cutoff did not beat 0.5.
import "dotenv/config";
import { existsSync, readFileSync } from "fs";
import { isGenuinelyRelevant } from "../../src/services/tieredRecommendation.js";
import { jevRelevance } from "../../src/services/jevClassifiers.js";
import { jevAvailable } from "../../src/services/jev.js";

const SYNTHETIC: [string, string, string, boolean][] = [
  ["salsa dancing", "Salsa Social Night", "Beginner lesson at 7 then open dancing until midnight, no partner needed.", true],
  ["salsa dancing", "Latin Food Festival", "Tacos, pupusas and live music from local vendors all afternoon.", false],
  ["board game night", "Tabletop Tuesday", "Weekly board game night at a cafe, hundreds of games to borrow.", true],
  ["board game night", "Founders Trivia Night", "Startup-themed trivia with prizes, teams of four.", false],
  ["rock climbing", "Bouldering Basics", "Learn to boulder with an instructor, shoes included.", true],
  ["rock climbing", "Trail Running Meetup", "Easy 5 mile trail run in Marin followed by coffee.", false],
  ["book club", "Fiction Book Club: The Left Hand of Darkness", "We discuss this month's novel over wine.", true],
  ["book club", "Author Talk with a Bestselling Novelist", "Ticketed talk with book signing, 600 seats.", false],
  ["photography walk", "Golden Hour Photo Walk", "Bring your camera; guided walk through the Mission murals.", true],
  ["photography walk", "Photography Exhibit Opening", "Gallery opening of a landscape photography show with wine.", false],
  ["AI founders meetup", "AI Founders Dinner", "Twenty founders building AI companies share what's working, small table, no slides.", true],
  ["AI founders meetup", "AI Hack Weekend", "Two days building with new APIs, prizes for top teams.", false],
  ["AI founders meetup", "Enterprise AI Summit", "3,000 attendees, keynotes, vendor expo, networking lounge.", false],
  ["women in tech", "Women in Tech Happy Hour", "Monthly social for women working in tech, casual, all levels.", true],
  ["women in tech", "Tech Recruiting Fair", "Booths from 80 companies hiring engineers, open to all.", false],
  ["product designers community", "Product Design Night", "Monthly meetup where product designers share work in progress and give each other feedback.", true],
  ["product designers community", "Design Systems Conference", "Two-day paid conference with 40 speakers on design systems.", false],
  ["climate startup founders", "Climate Founders Breakfast", "Founders of early-stage climate startups meet monthly over breakfast.", true],
  ["climate startup founders", "Climate Policy Panel", "Panel of policymakers discusses upcoming regulation, Q&A.", false],
  ["meet investors", "Seed Investor Office Hours", "Book a slot with active seed investors for feedback on your pitch.", true],
  ["meet investors", "Startup Career Panel", "Panel on working at startups vs big tech for job seekers.", false],
  ["founder community", "Build Night", "Weekly drop-in evening where founders work on their projects side by side and swap notes.", true],
  ["founder community", "48 Hour Startup Weekend", "Pitch ideas Friday, form teams, launch by Sunday, judges award prizes.", false],
  ["chess night", "OpenAI Chess Club", "Hosted at OpenAI's office; casual chess with boards provided, all levels.", true],
  ["chess night", "Chess Engine Talk", "An OpenAI researcher talks about neural chess engines, 40 minutes plus Q&A.", false],
  ["pottery class", "Stripe Team Offsite Pottery", "Private team-building pottery workshop for Stripe employees only.", false],
  ["running club", "Saturday Long Run", "Weekly 10 mile group run from Golden Gate Park, all paces, coffee after.", true],
  ["running club", "Marathon Expo", "Packet pickup, vendors and expo for the city marathon.", false],
  ["language exchange Spanish", "Spanish Conversation Night", "Casual practice with native speakers over drinks.", true],
  ["language exchange Spanish", "French Conversation Night", "Casual practice with native speakers over drinks.", false],
  ["AI meetup", "LLM Evals Meetup", "Engineers share how they evaluate LLM apps, lightning talks and open discussion.", true],
  ["AI meetup", "Blockchain Builders Mixer", "Founders and devs building on-chain apps meet for drinks.", false],
  ["hiking", "Sunday Ridge Hike", "8 mile group hike with views, carpool from the city.", true],
  ["hiking", "Outdoor Gear Swap", "Bring and swap used outdoor gear, coffee provided.", false],
  ["tech events this week", "SF Tech Week: Robotics Demo Day", "Startups demo robots to the public and investors.", true],
  ["tech events this week", "Community Garden Volunteer Day", "Help plant winter vegetables at the neighborhood garden.", false],
  ["tech events this week", "Founders' Fireside at a Tech Week Office", "Talk with a Series B founder about scaling, Q&A.", true],
  ["tech events this week", "Wine Tasting Evening", "Five wines from Sonoma with a sommelier.", false],
  ["networking with VCs", "VC Speed Meetings", "Twenty minute rotating meetings with partners from local funds.", true],
  ["networking with VCs", "Fundraising Basics Workshop", "A lawyer explains term sheets, no investors attend.", false],
];

async function main() {
  if (!jevAvailable()) {
    console.log("No Jev key here. Run through `railway run` or set it in api/.env.");
    process.exit(2);
  }
  const local = new URL("./blind.local.json", import.meta.url);
  const extra: [string, string, string, boolean][] = existsSync(local)
    ? (JSON.parse(readFileSync(local, "utf8")) as { ask: string; name: string; description: string; label: boolean }[]).map((c) => [c.ask, c.name, c.description, !!c.label])
    : [];
  const cases = [...SYNTHETIC, ...extra];
  let claudeRight = 0;
  const jevRight: Record<string, number> = { "0.5": 0, "0.45": 0 };
  let onlyJev = 0;
  let onlyClaude = 0;
  for (const [ask, name, description, label] of cases) {
    const c = (await isGenuinelyRelevant(ask, name, "San Francisco", description)).fit;
    const p = (await jevRelevance(ask, name, "San Francisco", description, { yes: 0.5, high: 0.85, medium: 0.6 }))?.p ?? 0;
    if (c === label) claudeRight++;
    for (const t of [0.5, 0.45]) if ((p >= t) === label) jevRight[String(t)]++;
    if ((p >= 0.5) === label && c !== label) onlyJev++;
    if (c === label && (p >= 0.5) !== label) onlyClaude++;
  }
  const pct = (k: number) => `${k}/${cases.length} = ${Math.round((k / cases.length) * 100)}%`;
  console.log(`${cases.length} cases`);
  console.log(`Claude: ${pct(claudeRight)}`);
  for (const t of ["0.5", "0.45"]) console.log(`Jev @${t}: ${pct(jevRight[t])}`);
  console.log(`Only Jev right: ${onlyJev}, only Claude right: ${onlyClaude}`);
  process.exit(0);
}
main();
