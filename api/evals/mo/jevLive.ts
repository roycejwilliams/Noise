// Live check of Mo's Jev layer against labels written BEFORE running
// (2026-09-23). Invented posts and replies, no member data.
//
// Posts: "good" = a person doing something themselves Mo should consider;
// "bad" = promotion, job ad, company account, or nothing they're doing.
// Jev may only drop "bad" ones; a dropped "good" one is the failure that
// matters. Replies: compared with Claude Haiku (the current fallback).
//
//   railway run --service co-test --environment dev -- npx tsx evals/mo/jevLive.ts
// (needs TYPESAFE_API_KEY on co-test; the Claude half runs without it)
import "dotenv/config";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../../src/models.js";
import { moJevEnabled, readReplyWithJev, screenPosts } from "../../src/mo/jev.js";

type P = { id: string; text: string; name: string; bio: string; label: "good" | "bad" };
const POSTS: P[] = [
  { id: "g1", label: "good", name: "Noor Haddad", bio: "design eng", text: "Hosting another design-engineer dinner in the Mission next week. 12 people who ship 0 to 1 products, no pitching allowed." },
  { id: "g2", label: "good", name: "Ellis Park", bio: "climate hardware", text: "Just moved to SF from Austin to build a climate hardware startup. Looking for a technical cofounder who's done embedded systems." },
  { id: "g3", label: "good", name: "Sarah Hao", bio: "founder @ stealth", text: "Week 3 of building our AI tutoring app in SoMa. First 40 students onboarded, learning a ton." },
  { id: "g4", label: "good", name: "Jordan Lee", bio: "community + coffee", text: "Starting a Saturday morning builders' walk around Dolores Park. Bring what you're working on, leave with a new friend." },
  { id: "g5", label: "good", name: "Maya Ortiz", bio: "product designer", text: "Looking for 2-3 designers in SF who want to do a weekly crit night. I'll host at my place in Hayes Valley." },
  { id: "g6", label: "good", name: "Dev Patel", bio: "eng, building", text: "Shipped the first version of our open-source scheduling tool tonight. Small team, all in SF, would love feedback from other builders." },
  { id: "g7", label: "good", name: "Priya Nair", bio: "biotech founder", text: "Our lab-in-a-box prototype finally worked end to end. Raising a small pre-seed in the Bay Area, happy to share what we learned." },
  { id: "g8", label: "good", name: "Sam Rivera", bio: "writer, organizer", text: "Organizing a founders-and-artists salon in the Mission on Oct 12. 20 seats, mostly people who've never been in the same room." },
  { id: "g9", label: "good", name: "Ana Kim", bio: "ML eng", text: "Quit my job last month to work on voice agents full time. In SF, looking for someone strong on go-to-market." },
  { id: "g10", label: "good", name: "Leo Grant", bio: "hardware", text: "Building a small robotics workshop out of a garage in the Dogpatch. Open bench nights on Thursdays if you're working on something physical." },
  { id: "g11", label: "good", name: "Zoe Chen", bio: "founder", text: "we finally have our first paying customer!! two of us, SF, no funding yet, figuring it out as we go" },
  { id: "g12", label: "good", name: "Omar Aziz", bio: "PM turned founder", text: "Running a small monthly dinner for first-time founders in SF. Next one's the 30th, DM if you're building something." },
  { id: "g13", label: "good", name: "Riley Brooks", bio: "designer + dev", text: "Spent the weekend prototyping a tool for event hosts to see who should meet who. Anyone in SF want to try it?" },
  { id: "g14", label: "good", name: "Tess Morgan", bio: "fintech", text: "Two months into building a savings app for gig workers. Looking to talk to anyone in the Bay who's done consumer fintech." },
  { id: "g15", label: "good", name: "Kai Nguyen", bio: "climate", text: "Hosting a small climate founders breakfast in SoMa this Friday. 8 seats left." },
  { id: "b1", label: "bad", name: "Growth Guru", bio: "helping founders 10x", text: "10 growth hacks every founder NEEDS in 2026. Thread. Like and repost to get my free playbook!" },
  { id: "b2", label: "bad", name: "Acme Careers", bio: "jobs at acme", text: "We're hiring! Senior engineers wanted at Acme Corp, SoMa office. Apply at the link." },
  { id: "b3", label: "bad", name: "SF Startup News", bio: "daily startup news", text: "BREAKING: Another SF AI startup raises $40M Series B. Here's what it means for the market." },
  { id: "b4", label: "bad", name: "Mark T", bio: "investor", text: "Hot take: most founders in SF are building the wrong thing. Fight me." },
  { id: "b5", label: "bad", name: "EventHub SF", bio: "the best events in SF", text: "Tickets now on sale for SF Startup Mixer! 500+ attendees, open bar, use code EARLY for 20% off." },
  { id: "b6", label: "bad", name: "CryptoKing", bio: "DM for signals", text: "Giveaway! Follow, like, and comment 'SF' to win $500 in crypto. Winners picked Friday." },
  { id: "b7", label: "bad", name: "Lena W", bio: "", text: "the fog in SF today is unreal lol" },
  { id: "b8", label: "bad", name: "DevTools Inc", bio: "developer tools company", text: "Our new release ships today: faster builds, better logs. Try it free for 30 days." },
  { id: "b9", label: "bad", name: "Coach Ray", bio: "founder coach", text: "Book a 1:1 with me and I'll show you exactly how to raise your seed round. Only 3 spots left this month." },
  { id: "b10", label: "bad", name: "Tom B", bio: "vc", text: "Great panel tonight at the SF founders summit. The best advice: talk to your users." },
  { id: "b11", label: "bad", name: "TechRecruit", bio: "recruiting for top startups", text: "Looking for founding engineers for 5 stealth startups in SF. DM me your resume." },
  { id: "b12", label: "bad", name: "Priya S", bio: "reader", text: "Anyone have good book recommendations for a long flight?" },
  { id: "b13", label: "bad", name: "SaaS Deals", bio: "deals for founders", text: "Founders: get 50% off 12 SaaS tools this week only. Link in bio." },
  { id: "b14", label: "bad", name: "Alex R", bio: "", text: "Retweeting this because everyone in SF needs to read it." },
  { id: "b15", label: "bad", name: "Bay Area Meetups", bio: "meetup aggregator", text: "This week's top 50 tech meetups in the Bay Area, all in one list." },
];
type R = { text: string; label: "yes" | "no" | "question" };
const REPLIES: R[] = [
  { text: "yes please!", label: "yes" },
  { text: "Sure, send it over", label: "yes" },
  { text: "I'd love one, thank you", label: "yes" },
  { text: "count me in", label: "yes" },
  { text: "oh nice, yeah I'm interested", label: "yes" },
  { text: "no thanks", label: "no" },
  { text: "not interested, please don't message me again", label: "no" },
  { text: "I'll pass, but appreciate it", label: "no" },
  { text: "who is this?", label: "question" },
  { text: "What does it cost?", label: "question" },
  { text: "Who else is in it?", label: "question" },
  { text: "how did you find me?", label: "question" },
  { text: "Maybe, what kind of people are in it?", label: "question" },
  { text: "yes but what is it exactly?", label: "question" },
  { text: "lol is this a bot", label: "question" },
  { text: "Not right now, maybe later", label: "no" },
];

async function haikuReply(text: string): Promise<string> {
  const { text: out } = await generateText({
    model: anthropic(MODELS.haiku),
    prompt: `Co invited someone to a private club by DM and asked if they'd like an invite. Their reply: "${text}"\n\nAnswer with one word: yes (they want the invite), no (they don't, or want to be left alone), or question (anything else, including questions).`,
  });
  const w = out.trim().toLowerCase();
  return w.startsWith("yes") ? "yes" : w.startsWith("no") ? "no" : "question";
}

if (!moJevEnabled()) console.log("No TYPESAFE_API_KEY: only the Claude half runs.\n");
else {
  const input = POSTS.map((p) => ({ id: p.id, text: p.text, author: { username: p.id, name: p.name, description: p.bio } }));
  const r = await screenPosts(input);
  const dropped = new Set(r.dropped.map((d) => d.post.id));
  const goodDropped = POSTS.filter((p) => p.label === "good" && dropped.has(p.id));
  const badDropped = POSTS.filter((p) => p.label === "bad" && dropped.has(p.id));
  console.log(`POST SCREEN (Jev, ${r.ms}ms for ${POSTS.length} in parallel)`);
  console.log(`  bad posts dropped before Claude: ${badDropped.length} of 15`);
  console.log(`  GOOD posts wrongly dropped:      ${goodDropped.length} of 15 ${goodDropped.map((p) => p.id).join(" ")}`);
  for (const d of r.dropped) console.log(`   drop ${d.post.id} doing=${d.p.doing.toFixed(2)} promo=${d.p.promo.toFixed(2)} org=${d.p.org.toFixed(2)}`);
}

let jevRight = 0, jevDecided = 0, cascadeRight = 0, haikuRight = 0;
const t0 = Date.now();
for (const r of REPLIES) {
  const h = await haikuReply(r.text);
  if (h === r.label) haikuRight++;
  if (moJevEnabled()) {
    const j = await readReplyWithJev(r.text);
    if (j.verdict) {
      jevDecided++;
      if (j.verdict === r.label) jevRight++;
      else console.log(`   Jev wrong: "${r.text}" → ${j.verdict} (label ${r.label}) ${JSON.stringify(j.p)}`);
    }
    if ((j.verdict ?? h) === r.label) cascadeRight++;
  }
}
console.log(`\nREPLIES (${REPLIES.length} labelled)`);
console.log(`  Claude Haiku alone: ${haikuRight}/${REPLIES.length}`);
if (moJevEnabled()) {
  console.log(`  Jev decided ${jevDecided}, right on ${jevRight}; the rest went to Claude`);
  console.log(`  Jev then Claude (what Mo runs): ${cascadeRight}/${REPLIES.length}`);
}
console.log(`  (${Date.now() - t0}ms total)`);
process.exit(0);
