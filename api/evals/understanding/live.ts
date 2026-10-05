// Live check of "always figuring something out, only where the conversation
// leads" (services/understanding.ts): curiosity check-ins write only when
// their own words lead there, and the coverage check only counts what they
// said in this conversation as freshly heard. Real models, no DB, nothing sent.
//
//   railway run --service co-test --environment dev -- npx tsx evals/understanding/live.ts [runs]
const { draftCompanionCheckin } = await import("../../src/agent/companionCheckin.js");
const { assessConversationCoverage } = await import("../../src/services/profileExtraction.js");
const runs = Number(process.argv[2] ?? 2);
const cases: { name: string; about: string; words: string; shouldWrite: boolean }[] = [
  {
    name: "leads there: stressed about the event",
    about: "what they're working toward or struggling with",
    words: "User said: finally locked the venue for the 10th\nCo replied: That's a big one off the list.\nUser said: now I just need people to actually show up lol, sponsors too",
    shouldWrite: true,
  },
  {
    name: "leads there: new job mention",
    about: "what's going on in their life right now",
    words: "User said: sorry been slow, first week at the new job has been a lot\nCo replied: No worries at all.",
    shouldWrite: true,
  },
  {
    name: "nothing leads there: only logistics",
    about: "their longer-horizon personal and career direction",
    words: "User said: Hi co can you send me a v card\nCo replied: Here you go. Save it so I'm easy to find.",
    shouldWrite: false,
  },
  {
    name: "nothing leads there: a thanks",
    about: "the kind of people they'd want to be introduced to",
    words: "User said: thanks for the link!\nCo replied: Anytime.",
    shouldWrite: false,
  },
];
let ok = 0, total = 0;
for (let r = 0; r < runs; r++)
  for (const c of cases) {
    const d = await draftCompanionCheckin("Sam", "", null, null, { topic: "x", about: c.about, theirWords: c.words });
    total++;
    const pass = !!d === c.shouldWrite;
    if (pass) ok++;
    console.log(`${pass ? "ok  " : "MISS"} ${c.name}: ${d ? d.text : "(skip)"}`);
  }
console.log(`curiosity check-ins: ${ok}/${total}`);

// Fresh vs known before.
let fok = 0;
for (let r = 0; r < runs; r++) {
  const a = await assessConversationCoverage(
    "user: ugh this week is packed, pitching investors thursday\nassistant: Big week. How are you feeling about it?",
    "long-term direction: wants to build a hardware company in 5 years; personality: dry humor, direct",
  );
  const fresh = a.fresh_topics ?? [];
  const pass = !fresh.includes("long_term_direction") && !fresh.includes("personality") && fresh.length > 0;
  if (pass) fok++;
  console.log(`${pass ? "ok  " : "MISS"} fresh topics: ${fresh.join(", ") || "(none)"}; missing: ${a.missing_topics.join(", ")}`);
}
console.log(`fresh topics only from this conversation: ${fok}/${runs}`);
