// PR C: small checker bugs (Royce, 2026-10-17: "Small checker bugs: the full-stop join, 'The Menu' as a name, 'Morning:' lines, the
// contrast failure that is flagged and never fixed"). Every case is a real refusal from the S1-a replay of harness_decisions on dev,
// in its own wording, with member names and private details swapped for invented ones (Royce: "J's fixtures: committed, names
// swapped"). Each "passes" case was refused on origin/co-test 48a370a0; each "still refused" case must stay refused.
// Zero tokens: the checks are code, no model is called.
//   npx tsx evals/files/checkerBugs.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
const { captionProblems } = await import("../../src/agent/loopTools.js");
const { placesClaimed } = await import("../../src/harness/matchGate.js");
const { headlineNameProblems } = await import("../../src/services/coPages/grounding.js");
const { checkPage } = await import("../../src/services/coPages/store.js");
const PT = await import("../../src/agent/pageTools.js");
const DS = await import("../../src/services/documentSheet.js");
const { contrast } = await import("../../src/services/coPages/style.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};

// ---------------------------------------------------------------- 1. the full-stop join (find captions)
// S1-a: 7 captions refused because the place check read across a full stop. The find's own facts weren't logged, so each fact line
// here is what the caption's own words say the page held (the place included).
const CAPTIONS: { origin: "real" | "test"; caption: string; facts: string; theirs: string }[] = [
  {
    origin: "test",
    caption: "Supabase Select Hackathon, Saturday 9-5 in SF. Builders, prize pool, and judges from Supabase, Stripe and Anthropic. Only 3 spots left and it needs host approval, so I'd move fast if it's your thing.",
    facts: "Supabase Select Hackathon. Saturday 9-5, San Francisco (SF). Builders, prize pool, judges from Supabase, Stripe and Anthropic. 3 spots left. Host approval required.",
    theirs: "Any good founder or tech events this weekend?",
  },
  {
    origin: "test",
    caption: "Supabase Select 2026 Hackathon, Saturday 9-5 in SF. Builders day with Stripe, Anthropic, and Vercel partners judging, free, but only 3 spots left and needs host approval.",
    facts: "Supabase Select 2026 Hackathon. Saturday 9-5, San Francisco (SF). A builders day, partners Stripe, Anthropic, Vercel judging. Free. 3 spots left. Host approval required.",
    theirs: "Any good founder or tech events this weekend?",
  },
  {
    origin: "real",
    caption: "The AI-Native Talent Hunt with Codex, Sunday Oct 11, 10-6 in SF. Live build competition against a real problem, builder and operator crowd, free, still taking registrations.",
    facts: "The AI-Native Talent Hunt with Codex. Sunday Oct 11, 10-6, San Francisco. Live build competition against a real problem. Builders and operators. Free. Registration open.",
    theirs: "Can you find me something that aligns with that?",
  },
  {
    origin: "test",
    caption: "Davis Square Runners does a Fells trail run every Sunday at 9am, meeting at the trailhead in Medford. It's 5 to 6 miles with the option for more if you want to go longer.",
    facts: "Sunday Fells Run, 5-6 miles with option for more (Davis Square Runners). Every Sunday 9am. Meets at the trailhead, Medford.",
    theirs: "want to plan something with a couple people this week, what works for me?",
  },
  {
    origin: "test",
    caption: "Bar Vlaha, right in Brookline near Coolidge Corner. Greek food, warm old-world vibe, good cocktails, and it's T-accessible so you don't have to fight for parking after a long shift.",
    facts: "Bar Vlaha. Greek food and cocktails. Brookline, at Coolidge Corner, near the T.",
    theirs: "any good restaurant for a date night with Ravi?",
  },
];
for (const c of CAPTIONS) check(`caption (${c.origin}) passes with its place in the facts: "${c.caption.slice(0, 60)}"`, captionProblems(c.caption, c.facts, c.theirs).length === 0, captionProblems(c.caption, c.facts, c.theirs));
check('a place that ends a sentence is the place alone: "in SF. Builders" claims SF', JSON.stringify(placesClaimed("A weekend hackathon in SF. Builders ship real apps.")) === JSON.stringify(["SF."]), placesClaimed("A weekend hackathon in SF. Builders ship real apps."));
check('"St. Louis" is still one place', JSON.stringify(placesClaimed("A run in St. Louis tomorrow.")) === JSON.stringify(["St. Louis"]), placesClaimed("A run in St. Louis tomorrow."));
check('... and a caption naming it passes when its facts do', captionProblems("A run in St. Louis tomorrow.", "Morning run, St. Louis, Forest Park.", "").length === 0, captionProblems("A run in St. Louis tomorrow.", "Morning run, St. Louis, Forest Park.", ""));
{
  // Still refused: a place the facts never name (the same caption, with facts that only say Brookline).
  const p = captionProblems(CAPTIONS[4].caption, "Bar Vlaha. Greek food and cocktails. Brookline, near the T.", CAPTIONS[4].theirs);
  check("still refused: a place not in the facts (Coolidge Corner, facts say only Brookline)", p.some((x) => x.includes("Coolidge Corner")), p);
  const q = captionProblems("Dinner in Fairhaven. Greek food, family style.", "Bar Vlaha. Greek food. Brookline.", "");
  check("still refused: a place never said that ends a sentence", q.some((x) => x.includes("Fairhaven")), q);
}

// ---------------------------------------------------------------- 2. common words read as names (deck headlines)
// Their words as the deck read them (their message plus 12 hours of texts). Wren's ceramics night, Marisol's fire dinners, Ellery's
// studio software and supper club (S1-a test members, names swapped).
const WREN = "Can you make me a deck for a ceramics night I'm hosting at Heath Ceramics in San Francisco on Saturday Nov 7? Twelve friends. Doors 6:30 PM, wheel demo by the studio team 7:15 PM, supper at a long table 8 PM, and at 9:30 PM everyone picks a cup to take home. Wear clothes that can take clay. I like warm earthy colors, terracotta and cream, with serif type.";
const MARISOL = "I'm a chef. I cook five course tasting dinners over open fire in people's homes, 8 to 14 guests, and I handle sourcing, service and cleanup. Make me a pitch deck for private dinner clients. The courses: oyster with smoked butter and charred lemon, ember roasted beet with whey and dill, lamb shoulder over coals with green garlic, plum with burnt honey and cultured cream. Look: dark and moody with a gold accent, serif.";
const ELM = "Can you make me a pitch deck for Elm Table, for seed investors? Use my logo, and I want it to feel like that green footer I sent. Elm Table is a members' supper club in SF: one long table for 12, a new chef in residence every month, members bring a guest. We want to raise to open a second room.";
const PASS: [string, string][] = [
  ["The Evening", WREN],
  ["9:30 PM: Choose a cup", WREN],
  ["9:30 PM: Choose your cup", WREN],
  ["The Menu", MARISOL],
  ["What's Included", MARISOL],
  ["14 studios. $89/month. Real revenue, right now.", ""],
  ["One table. Twelve seats. A new chef every month.", ELM],
];
for (const [h, theirs] of PASS) check(`headline passes: "${h}"`, headlineNameProblems(h, theirs, "slide 2 headline") === null, headlineNameProblems(h, theirs, "slide 2 headline"));
const STILL: [string, string, string][] = [
  ["14 studios in Oakland are already paying", "We help independent wellness studios with booking, reminders and deposits. 14 studios pay $89 a month.", "Oakland"],
  ["14 paying studios. $89/month. Growing in Oakland.", "We help independent wellness studios with booking, reminders and deposits. 14 studios pay $89 a month.", "Oakland"],
  ["Proof point: Acme, November launch party", "We're planning a November launch party.", "Acme"],
  ["Partnering with Founders Club and Signal", "", "Founders Club"],
];
{
  // The line check on decks (offerGuard unsourced, deckProblems) still reads "Choose" after a time as a name: this PR fixes the
  // headline check only. A further fix there was built and dropped (coordinator, 2026-10-17: a change that flips no refusal on the
  // S1-a replay set is dropped): every replayed deck with "9:30 PM: Choose a cup" is also refused for "8:00 PM" (see the PR's Needs
  // Royce). What must hold either way: a name after a time label is still refused.
  const { deckDataFrom } = await import("../../src/agent/deckTools.js");
  const input = { title: "Ceramics Night at Heath", subtitle: "An evening of clay and supper for twelve, Saturday November 7", slides: [{ headline: "6:30 PM: Doors", bullets: ["Arrive at Heath Ceramics"] }, { headline: "9:30 PM: Hollis Pottery", bullets: ["Everyone takes one home"] }] } as any;
  const named = input.slides.map((s: any, i: number) => headlineNameProblems(s.headline, WREN, `slide ${i + 2} headline`)).filter(Boolean);
  const c = checkPage(await deckDataFrom(input, null, new Map(), null, { theirWords: WREN }), { theirs: WREN, read: "" });
  check('still refused on a deck: a name after a time label ("9:30 PM: Hollis Pottery"), by the headline check and the line check', named.some((x: string) => /Hollis/.test(x)) && !c.ok && c.problems.some((x) => /Hollis/.test(x)), { named, line: c.ok ? "passed" : c.problems });
}
for (const [h, theirs, name] of STILL) {
  const p = headlineNameProblems(h, theirs, "slide 4 headline");
  check(`still refused: "${h}" names ${name}`, !!p && p.includes(name), p);
}

// ---------------------------------------------------------------- 3. page structure lines
// Tamsin's cabin weekend (an S1-a test member, name swapped), as the page tool read it.
const TAMSIN = "Make me a page for our cabin weekend on Mt Hood, Friday Oct 23 to Sunday Oct 25, four of us. We're staying at Timberline Lodge. Friday leave Portland at 4 PM, check in at 5:30 PM, dinner at the lodge at 7 PM. Saturday coffee at 9 AM, then the hike to Multnomah Falls at 11 AM, back by 3 PM. Sunday breakfast in Government Camp, home by early afternoon.";
const cabin = (sunday: { lead?: string; text: string }[]) => ({
  why: "They asked for a page for their cabin weekend itinerary.",
  line: "Here's your Mt Hood weekend, Friday through Sunday.",
  place: "Timberline Lodge, Government Camp, Oregon",
  title: "Mt Hood Cabin Weekend",
  context: "Friday Oct 23 to Sunday Oct 25, four of you at Timberline Lodge",
  sections: [
    { heading: "Friday, Oct 23", blocks: [{ type: "bullets", items: [{ lead: "4:00 PM", text: "Leave Portland" }, { lead: "5:30 PM", text: "Check in at Timberline Lodge" }, { lead: "7:00 PM", text: "Dinner at the lodge" }] }] },
    { heading: "Saturday, Oct 24", blocks: [{ type: "bullets", items: [{ lead: "9:00 AM", text: "Coffee" }, { lead: "11:00 AM", text: "Hike to Multnomah Falls" }, { lead: "3:00 PM", text: "Back at the lodge" }] }] },
    { heading: "Sunday, Oct 25", blocks: [{ type: "bullets", items: sunday }] },
  ],
  artDirection: "fieldguide",
  designContext: "personal",
});
const pageCheck = async (input: any, theirs: string) => {
  const words = await PT.pageWords(input, theirs);
  const c = checkPage(PT.pageDataFrom(words as any, { style: null, assets: new Map() }), { theirs, read: "" });
  return c.ok ? [] : c.problems;
};
for (const [label, sunday] of [
  ['"Morning: Breakfast in Government Camp" and "Early afternoon: Head home"', [{ lead: "Morning", text: "Breakfast in Government Camp" }, { lead: "Early afternoon", text: "Head home" }]],
  ['"Head home, early afternoon"', [{ text: "Breakfast in Government Camp" }, { text: "Head home, early afternoon" }]],
  ['"Head home in the early afternoon"', [{ text: "Breakfast in Government Camp" }, { text: "Head home in the early afternoon" }]],
] as [string, { lead?: string; text: string }[]][]) {
  const p = await pageCheck(cabin(sunday), TAMSIN);
  check(`page passes: ${label}`, p.length === 0, p);
}
{
  // "Date:" is a label like "When:"; the date itself is still checked.
  const BRIGHT = "Can you make me a page for our Brightwater launch dinner? Saturday Oct 24 at 7pm at Birch and Bell, 20 guests, cocktails at 7 then dinner at 7:45, dress is smart casual. Put our logo on it.";
  const dinner = (date: string) => ({
    line: "Here's the page for the Brightwater launch dinner.",
    title: "Brightwater Launch Dinner",
    context: "Saturday October 24 at Birch and Bell, 20 guests, smart casual",
    sections: [
      { heading: "The Evening", blocks: [{ type: "bullets", items: [{ lead: "7:00 PM", text: "Cocktails" }, { lead: "7:45 PM", text: "Dinner" }] }] },
      { heading: "Details", blocks: [{ type: "bullets", items: [{ lead: "Where", text: "Birch and Bell" }, { lead: "Guests", text: "20" }, { lead: "Dress", text: "Smart casual" }, { lead: "Date", text: date }] }] },
    ],
  });
  const ok = await pageCheck(dinner("Saturday October 24"), BRIGHT);
  check('page passes: "Date: Saturday October 24"', ok.length === 0, ok);
  const bad = await pageCheck(dinner("Saturday October 31"), BRIGHT);
  check('still refused: "Date: Saturday October 31" (a date they never gave)', bad.some((x) => /31/.test(x)), bad);
}
{
  const p = await pageCheck(cabin([{ lead: "Morning", text: "Brunch at Cloud Cap Inn" }, { text: "Head home, early afternoon" }]), TAMSIN);
  check('still refused: "Morning: Brunch at Cloud Cap Inn" (a place never said)', p.some((x) => /Cloud Cap Inn|cloud|inn/i.test(x)), p);
  const t = await pageCheck(cabin([{ lead: "8:00 PM", text: "Supper at the lodge" }]), TAMSIN);
  check('still refused: "8:00 PM: Supper" on a page when no one said 8 PM', t.some((x) => /8:00 PM|8pm/i.test(x)), t);
  const m = await pageCheck(cabin([{ lead: "Morning", text: "Breakfast in Government Camp" }, { lead: "9:30 AM", text: "Head home" }]), TAMSIN);
  check('still refused: a clock time on a structure line ("9:30 AM: Head home") needs support', m.some((x) => /9:30/.test(x)), m);
}
{
  // On a deck too, a time nobody gave stays refused (Wren said doors at 6:30, not 7).
  const { deckDataFrom } = await import("../../src/agent/deckTools.js");
  const data = await deckDataFrom({ title: "Ceramics Night", subtitle: "Heath Ceramics, San Francisco, Saturday, November 7", slides: [{ headline: "The evening", bullets: ["7:00 PM: Doors open", "8 PM: Supper at a long table"] }, { headline: "One thing to know", bullets: ["Wear clothes that can take clay"] }] } as any, null, new Map(), null, { theirWords: WREN });
  const c = checkPage(data, { theirs: WREN, read: "" });
  check('still refused on a deck: "7:00 PM: Doors open" when they said doors at 6:30', !c.ok && c.problems.some((x) => /7:00 PM/.test(x)), c.ok ? "passed" : c.problems);
}

// ---------------------------------------------------------------- 4. the document label contrast design QA flagged and nothing fixed
{
  const doc = DS.resolveDocument({ title: "Supper club partnership", note: "What we talked about.", sections: [{ heading: "The idea", bullets: ["One long table, a new chef each month"] }], suggestions: ["Ask the wine importer about a pour"] });
  const colors = (html: string) => ({
    h3: html.match(/h3 \{[^}]*?color: (#[0-9A-Fa-f]{6})/)?.[1] ?? "",
    num: html.match(/h2::before \{[^}]*?color: (#[0-9A-Fa-f]{6})/)?.[1] ?? "",
    marker: html.match(/li::marker \{ color: (#[0-9A-Fa-f]{6})/)?.[1] ?? "",
  });
  const cue = colors(DS.documentHtml(doc, { firstName: "Wren", date: "October 17" }));
  check(`doc labels read 4.5:1 on Cue's paper (h3 ${cue.h3}, numbers ${cue.num})`, contrast(cue.h3, DS.PAPER.paper) >= 4.5 && contrast(cue.num, DS.PAPER.paper) >= 4.5, { ...cue, h3: contrast(cue.h3, DS.PAPER.paper), num: contrast(cue.num, DS.PAPER.paper) });
  check("the label is the gold deepened (#77654B), and the list markers stay gold", cue.h3.toUpperCase() === "#77654B" && cue.marker.toUpperCase() === DS.PAPER.gold, cue);
  // A member's look whose accent reads only 3:1 on their paper (allowed as the accent; too light for small labels).
  const look = { mood: "light", background: "#FFFFFF", text: "#1A1A1A", accent: "#8C8C8C", type: "sans" } as any;
  check("the test look's accent is in the 3:1 to 4.5:1 band", contrast(look.accent, look.background) >= 3 && contrast(look.accent, look.background) < 4.5, contrast(look.accent, look.background));
  const theirs = colors(DS.documentHtml(doc, { firstName: "Wren", date: "October 17", look }));
  check(`doc labels read 4.5:1 on a member's look with a 3:1 accent (h3 ${theirs.h3})`, contrast(theirs.h3, look.background) >= 4.5 && contrast(theirs.num, look.background) >= 4.5, { ...theirs, h3: contrast(theirs.h3, look.background) });
  check("... and their accent still marks the list", theirs.marker.toUpperCase() === look.accent, theirs);
}

// ---------------------------------------------------------------- 5. a refused task document is logged as rules, never member text
// Royce, 2026-10-18: "#239 task-document log: drop it. Logs hold the rule and the kind of thing, never member text." The refused
// row carries where each problem sits and its kind ("section 1 line 1: a line their words don't back"), not the document; the reason
// field too (it used to quote the refused lines). The row is
// written inside the task runner's real wiring (a DB insert, no seam), so its line is read, and refusalKinds is run on a real refusal.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/services/taskTurn.ts", import.meta.url), "utf8");
  const row = src.split("\n").find((l) => l.includes('decision: "task.writeDocument"')) ?? "";
  check("the task-document row no longer carries the document (no input, no resolveDocument in the row)", !!row && !/\binput\b/.test(row.replace(/refusalKinds\(r\.problems, DS\.resolveDocument\(input\)\)/, "")) && /\.\.\.\(refused \? \{ refused \} : \{\}\)/.test(row) && /refused \? `Not sent: \$\{refused\.join\("; "\)\}`/.test(row), row.trim().slice(0, 400));
  // A real refusal (S1-a's wine-partner positioning document, a test member, names swapped), through the document check.
  const doc = DS.resolveDocument({
    title: "Fieldhouse x Wine Partner: Positioning",
    sections: [
      { heading: "What it is", bullets: ["Marlow hand-places every seat the night before, built from who should meet", "They pick the pairings together with Fieldhouse's chef."] },
      { heading: "Open questions", bullets: ["[Example to drop in: who sat where at West Town, and why that pour landed]"] },
    ],
    suggestions: ["Lead with the seating, then the pour"],
  });
  const theirs = "We run Fieldhouse dinners, I seat people by hand. Talking to a wine importer about a partnership.";
  const problems = DS.documentProblems(doc, { theirs, read: "" });
  const kinds = DS.refusalKinds(problems, doc);
  const VOCAB = /^(section \d+ (line \d+|heading)|suggestion \d+|title|the document): (a name or time they never gave|a name or number they never gave|a name, place or time they never said|a line their words don't back|a line the judge read as not theirs|a placeholder|no title|no sections|too thin|too long|a paragraph too long|no bullets|points that repeat their headings|another document rule)$/;
  check("a real refusal is logged as kinds only: every entry is a rule and a place, no member text", problems.length > 0 && kinds.length === problems.length && kinds.every((k) => VOCAB.test(k)), { problems: problems.length, kinds });
  check("... and where it sits, by section and line (found from the quoted line)", kinds.includes("section 1 line 1: a line their words don't back") && kinds.includes("section 2 line 1: a name or number they never gave"), kinds);
  const words = new Set(`${doc.title} ${doc.sections.flatMap((x) => [x.heading ?? "", ...x.bullets]).join(" ")}`.toLowerCase().match(/[a-z']{5,}/g) ?? []);
  const leaked = kinds.flatMap((k) => (k.toLowerCase().match(/[a-z']{5,}/g) ?? []).filter((w) => words.has(w) && !["section", "their", "words", "never"].includes(w)));
  check("... with none of the document's own words in it", leaked.length === 0, leaked);
}

// ---------------------------------------------------------------- 6. made-up content the first version let through (review of #239)
// Each was refused on origin/co-test and must stay refused: the fixes above loosen casing, structure and joins, never a made-up
// place, name or time.
{
  const MG = await import("../../src/harness/matchGate.js");
  const VLAHA = "Bar Vlaha. Greek food and cocktails, dress smart. Brookline, near the T.";
  for (const cap of ["Bar Vlaha, a cozy spot in W. Fakeville with Greek food and cocktails.", "Bar Vlaha, tucked in Dr. Pelletier's old building, Greek food and cocktails.", "Bar Vlaha, in N. Fakeborough, Greek food and cocktails.", "Bar Vlaha, in Pt. Fakeyes, Greek food and cocktails.", "Bar Vlaha, in Fakeville. Greek food and cocktails."]) {
    const p = captionProblems(cap, VLAHA, "");
    check(`still refused, caption: "${cap.slice(10, 60)}"`, p.length > 0, p);
  }
  check('"U.S. Virgin Islands" is one place, not "U.S."', JSON.stringify(MG.placesClaimed("Open studio in U.S. Virgin Islands this week.")) === JSON.stringify(["U.S. Virgin Islands"]), MG.placesClaimed("Open studio in U.S. Virgin Islands this week."));
  check('"W. Fakeville" is one place, not "W."', JSON.stringify(MG.placesClaimed("Wine bar in W. Fakeville, cozy.")) === JSON.stringify(["W. Fakeville"]), MG.placesClaimed("Wine bar in W. Fakeville, cozy."));
  const t3 = (reason: string, evidence: string) => MG.checkGrounding({ tier: 3, source: "x", name: "Builders Night", url: "https://x.com/i/status/1", reason } as any, { searchCity: null, distanceMiles: null, evidence } as any);
  const t1 = (reason: string, city: string) => MG.checkGrounding({ tier: 1, name: "Builders Night", url: "https://x.com", reason, city } as any, { searchCity: null, distanceMiles: null } as any);
  check("still refused, tier 3: a place the post never names (W. Fakeville)", !t3("Builders Night in W. Fakeville, open to all", "Builders Night, an open meetup for builders w/ pizza. San Francisco.").pass);
  check("still refused, tier 3: Dr. Pelletier's office, not in the post", !t3("Builders Night in Dr. Pelletier's office", "Builders Night hosted by Dr. Lee, open meetup. San Francisco.").pass);
  check("still refused, tier 1: W. Fakeville for an event in New York", !t1("Builders night in W. Fakeville", "New York").pass);

  // Re-review of #239: a one-word place cut at a point is backed only as a whole word ("Gov" isn't "Government"), in captions, task
  // texts and plan sheets (all placesBacked). Refused on co-test and here.
  const { placesBacked } = await import("../../src/services/taskWeb.js");
  check('still refused: "in Gov. Pelletier\'s lodge" when the facts say "Government Camp"', !placesBacked("A rooftop show in Gov. Pelletier's lodge.", "Rooftop show at the Government Camp lodge.").ok, placesBacked("A rooftop show in Gov. Pelletier's lodge.", "Rooftop show at the Government Camp lodge."));
  check('still refused: "in Rev. Pelletier\'s church" when the facts say "Revenue"', !placesBacked("A rooftop show in Rev. Pelletier's church.", "Rooftop show. Revenue goes to charity.").ok, placesBacked("A rooftop show in Rev. Pelletier's church.", "Rooftop show. Revenue goes to charity."));
  check("still refused, tier 1: \"in Gov. Pelletier's office\" for an event at Government Camp", !t1("Night in Gov. Pelletier's office", "Government Camp").pass);
  check("still refused, caption: Gov. Pelletier's lodge", captionProblems("Rooftop show in Gov. Pelletier's lodge, free.", "Rooftop show at the Government Camp lodge. Free.", "").length > 0);
  // City short names behave exactly as on co-test (re-review of #239: short-city matching is out of C's scope). These pass on
  // co-test and must still pass: NY for NYC, LA for Los Angeles, DC for Washington, DC, Bogota for Bogotá.
  const loc = (city: string, searchCity: string) => MG.checkLocation({ tier: 2, name: "x", city } as any, { searchCity, distanceMiles: null } as any);
  check('"in NY" for an event in NYC, and an NYC event for a search in NY', t1("Builders night in NY", "NYC").pass && loc("NYC", "NY").pass && loc("New York, NY", "NY").pass);
  check('"in LA" for an event in Los Angeles', t1("Builders night in LA", "Los Angeles").pass);
  check('"in DC" for an event in Washington, DC', t1("Builders night in DC", "Washington, DC").pass);
  check('"in Bogota" for an event in Bogotá', t1("Night in Bogota", "Bogotá").pass && loc("Bogotá", "Bogota").pass);
  // ... and a city's other names never back a different place (refused on co-test, must stay refused; the final pass on #239 found
  // an alias rule that passed every one of these).
  check('still refused: "in New York City" backed by "Albany, NY"', !placesBacked("A rooftop show in New York City tonight.", "Rooftop show, Albany, NY.").ok);
  check('still refused: "in NYC" backed by "Buffalo, NY"', !placesBacked("A rooftop show in NYC tonight.", "Rooftop show, Buffalo, NY.").ok);
  check('still refused: "in Los Angeles" backed by "La Jolla Cove, San Diego"', !placesBacked("A rooftop show in Los Angeles tonight.", "Rooftop show at La Jolla Cove, San Diego.").ok);
  check('still refused: "in Los Angeles" backed by "Bar La Cabra, Brooklyn"', !placesBacked("A rooftop show in Los Angeles tonight.", "Rooftop show at Bar La Cabra, Brooklyn.").ok);
  check('still refused: "in Washington DC" backed by "DC Ranch, Scottsdale"', !placesBacked("A rooftop show in Washington DC tonight.", "Rooftop show, DC Ranch, Scottsdale.").ok);
  check('still refused, tier 3: "in NYC" when the post says "Albany, NY"', !t3("Builders Night in NYC", "Builders Night, open meetup. Albany, NY.").pass);
  check('still refused, caption: "in NYC" when the facts say "Buffalo, NY"', captionProblems("Rooftop show Saturday in NYC, free.", "Rooftop show. Saturday. Buffalo, NY. Free.", "").length > 0);

  const H: [string, string, string][] = [
    ["Pelletier Evening", WREN, "Pelletier"],
    ["Seats go fast. Open Room hosts", `${WREN} the room`, "Open Room"],
    ["Doors at 6:30 PM. Open Room hosts", `${WREN} the room`, "Open Room"],
    ["9:30 PM: Choose Pelletier", WREN, "Pelletier"],
    ["9:30 PM: Choose a cup. Then Acme", WREN, "Acme"],
  ];
  for (const [h, theirs, name] of H) {
    const p = headlineNameProblems(h, theirs, "slide 2 headline");
    check(`still refused, headline: "${h}"`, !!p && p.includes(name.split(" ")[0]), p);
  }

  // One section only, so each case is refused (or not) for its own line.
  const sunday = (items: { lead?: string; text: string }[]) => ({ why: "x", line: "Here's your weekend.", title: "Mt Hood Cabin Weekend", context: "Friday Oct 23 to Sunday Oct 25, four of you at Timberline Lodge", sections: [{ heading: "Sunday, Oct 25", blocks: [{ type: "bullets", items }] }], artDirection: "fieldguide", designContext: "personal" });
  const FARM = "Make me a page for our cabin weekend on Mt Hood, Friday Oct 23 to Sunday Oct 25, four of us. We're staying at Timberline Lodge. Saturday coffee at 9 AM, then a guided wine tasting walk with pours at the farm at 11 AM. Sunday breakfast in Government Camp, home by early afternoon.";
  for (const [label, items] of [
    ['"Morning: Pelletier leads the guided wine tasting walk…"', [{ lead: "Morning", text: "Pelletier leads the guided wine tasting walk with pours at the farm" }]],
    ['"Breakfast: Pelletier leads the guided wine tasting walk…"', [{ lead: "Breakfast", text: "Pelletier leads the guided wine tasting walk with pours at the farm" }]],
    ['"Morning, Pelletier pours wine on the guided farm tasting walk"', [{ text: "Morning, Pelletier pours wine on the guided farm tasting walk" }]],
    ['"Leave by noon" (noon is a clock time)', [{ text: "Leave by noon" }]],
    ['"Noon: Head home" (noon is a clock time, never a label)', [{ lead: "Noon", text: "Head home" }]],
    ['"Dinner at the lodge Sunday night" (a part of the day mid-sentence is read)', [{ text: "Dinner at the lodge Sunday night" }]],
  ] as [string, { lead?: string; text: string }[]][]) {
    const p = await pageCheck(sunday(items), FARM);
    check(`still refused, page: ${label}`, p.length > 0 && p.every((x) => !/Mt Hood Cabin Weekend|Friday Oct 23/.test(x)), p);
  }
  const ok = await pageCheck(sunday([{ lead: "Morning", text: "Breakfast in Government Camp" }, { text: "Head home, early afternoon" }]), FARM);
  check("... while the structure lines Royce named still pass on the same source", ok.length === 0, ok);
}

// ---------------------------------------------------------------- 7. deck times read the way pages read them
// Royce, 2026-10-17: "Deck times: yes. '8:00 PM' matches the member's '8 PM', the same as pages. Made-up times stay refused ('8:00 PM:
// Supper' with nothing behind it)." S1-a: 15 Ceramics Night decks (test member, names swapped) were refused for "8:00 PM" when her
// message said "supper at a long table 8 PM".
{
  const { deckDataFrom } = await import("../../src/agent/deckTools.js");
  const deckCheck = async (slides: { headline: string; bullets: string[] }[], theirs: string) => {
    const named = slides.map((s, i) => headlineNameProblems(s.headline, theirs, `slide ${i + 2} headline`)).filter(Boolean) as string[];
    const c = checkPage(await deckDataFrom({ title: "Ceramics Night", subtitle: "Heath Ceramics, San Francisco, Saturday, November 7", slides } as any, null, new Map(), null, { theirWords: theirs }), { theirs, read: "" });
    return [...named, ...(c.ok ? [] : c.problems)];
  };
  const NOTIME = "Can you make me a deck for a ceramics night I'm hosting at Heath Ceramics in San Francisco on Saturday Nov 7? Twelve friends. Doors 6:30 PM, then supper at a long table, and everyone picks a cup to take home.";
  // The replayed deck (S1-a 16045's slides): every time is one she gave, in a different format.
  const real = await deckCheck([
    { headline: "Saturday, November 7th", bullets: ["Heath Ceramics, San Francisco", "Twelve friends, one long table"] },
    { headline: "6:30 PM: Doors", bullets: ["Arrive, settle in, say hello"] },
    { headline: "7:15 PM: Wheel demo", bullets: ["Led by the Heath studio team"] },
    { headline: "8:00 PM: Supper", bullets: ["At a long table, family style"] },
    { headline: "9:30 PM: Choose your cup", bullets: ["Everyone picks one to take home"] },
  ], WREN);
  check('deck passes: "8:00 PM: Supper" when she said "supper at a long table 8 PM" (and "9:30 PM: Choose your cup")', real.length === 0, real);
  const bullet = await deckCheck([{ headline: "The night", bullets: ["8:00 PM: Supper at a long table"] }, { headline: "One thing to know", bullets: ["Wear clothes that can take clay"] }], WREN);
  check('deck passes: "8:00 PM: Supper at a long table" as a bullet', bullet.length === 0, bullet);
  const made = await deckCheck([{ headline: "6:30 PM: Doors", bullets: ["Arrive at Heath Ceramics"] }, { headline: "8:00 PM: Supper", bullets: ["A long table, together"] }], NOTIME);
  check('still refused on a deck: "8:00 PM: Supper" when she gave no supper time', made.some((x) => /8:00 PM|8pm/.test(x)), made);
  const doors = await deckCheck([{ headline: "7:00 PM: Doors", bullets: ["Arrive at Heath Ceramics"] }, { headline: "8:00 PM: Supper", bullets: ["A long table, together"] }], WREN);
  check('still refused on a deck: "7:00 PM: Doors" when she said doors at 6:30', doors.some((x) => /7:00 PM|7pm/.test(x)) && !doors.some((x) => /8:00 PM|8pm/.test(x)), doors);
  // Format pairs, the same as pages (sameTimes): a time keeps its am/pm; only in their words does a bare "at 8" stand for 8am and 8pm.
  const pair = async (deckTime: string, theirs: string) => (await deckCheck([{ headline: "The night", bullets: [`${deckTime}: Supper at a long table`] }, { headline: "One thing to know", bullets: ["Wear clothes that can take clay"] }], `Ceramics night at Heath Ceramics, Saturday. Supper at a long table ${theirs}. Wear clothes that can take clay.`)).length === 0;
  check('format: "8pm" on the deck for their "8 PM"', await pair("8pm", "8 PM"));
  check('format: "8 PM" on the deck for their "8:00 pm"', await pair("8 PM", "8:00 pm"));
  check('format: "8:00 PM" on the deck for their bare "at 8" (pages read it the same way)', await pair("8:00 PM", "at 8"));
  check('format, still refused: "8:00 AM" on the deck for their "8 PM"', !(await pair("8:00 AM", "8 PM")));
  check('format, still refused: "8:30 PM" on the deck for their "8 PM"', !(await pair("8:30 PM", "8 PM")));
  // Times only, never dates (review of the deck-times commit): expanding "Sat Oct 31" to "Saturday October 31" let a date nobody gave
  // pass, because full month and weekday names skip the name check and decks have no number check in code.
  const DATED = "Make me a deck for a ceramics night with supper and a wheel demo, wear clothes that can take clay.";
  const dated = async (line: string, theirs: string) => deckCheck([{ headline: "The evening", bullets: [line] }, { headline: "One thing to know", bullets: ["Wear clothes that can take clay"] }], `${DATED} ${theirs}`);
  for (const [line, theirs] of [
    ["Doors open Sat Oct 31 at 6:30 PM", "Saturday Nov 7, doors 6:30 PM."],
    ["Doors open Sat Nov 14 at 6:30 PM", "Saturday Nov 7, doors 6:30 PM."],
    ["Supper on Fri Nov 6 at 8 PM", "Saturday Nov 7, supper at 8 PM."],
  ]) {
    const p = await dated(line, theirs);
    check(`still refused on a deck: "${line}" when they said "${theirs}"`, p.length > 0, p);
  }
  // The line check excuses a common word only right after a time label, not at a later sentence ("Room hosts" stays read).
  const room = await dated("9:30 PM: Choose a cup. Room hosts", "At 9:30 PM everyone picks a cup.");
  check('still refused on a deck: "9:30 PM: Choose a cup. Room hosts" (Room is read, as before)', room.some((x) => /Room/.test(x)), room);
}

console.log(`checker bugs: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
