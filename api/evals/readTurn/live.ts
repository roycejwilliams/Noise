// Live check of the one turn read (services/readTurn.ts) on Royce's real
// 09-28 turns. Real model, no DB, nothing sent.
//
//   railway run --service co-test --environment dev -- npx tsx evals/readTurn/live.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { readTurn } = await import("../../src/services/readTurn.js");
const ctx: any = {
  asks: [
    { text: "Find sponsors for the event", kind: "help" },
    { text: "Looking for a builder/founder community with people into design or experience building products 0 -> 1", kind: "find" },
    { text: "Seeking genuine friendships with dependable, intelligent people who want to work and build together", kind: "find" },
  ],
  threads: [
    { text: "considering taking a break from building the product, feeling his worth is tied to output", feeling: "burned out (medium)" },
    { text: "deciding whether to pursue an accelerator or get in touch with VCs", feeling: "avoidant (medium)" },
  ],
  offersThisWeek: 7,
  sent: [
    { name: "Grok Bot x Notion for Product Builders night (SF)", url: "https://lu.ma/grokbotproduct-sf" },
    { name: "daytonaio AI Builders Demo Night", url: "https://x.com/i/status/2102773693290336381" },
  ],
};
const grokNote = '[Replying to Co\'s text: "https://lu.ma/grokbotproduct-sf" (Short notice, but Grok Bot x Notion is throwing a product builders night in SF on Tuesday the 29th)]';
const t1122 = `User said: I'm in ${grokNote}\nCo replied: Both are the same night, so it's one or the other. Given you're leaning toward taking a break from building and just showing up somewhere, I'd pick this one.`;
const cases: { name: string; message: string; recent: string; openItems?: any[]; want: (r: any) => boolean }[] = [
  { name: "timing question", message: "Are they around the same time?", recent: t1122, want: (r) => ["logistics", "asking"].includes(r.moment.mode) && r.moment.dots.length === 0 && !!r.aboutSent },
  {
    name: "pushback on Oct 10",
    message: "This has nothing to do with Oct 10th.",
    recent: `User said: The reason being is because we can start planning peoples day around that so it's possible to make both given the timeframes\nCo replied: That's the right instinct for your own event, but it doesn't solve Tuesday. Where it actually matters is your Oct 10 block party.`,
    want: (r) => !!r.moment.pushback && !!r.moment.lesson,
  },
  {
    name: "I'm in under the link",
    message: `I'm in ${grokNote}`,
    recent: "Co replied: https://lu.ma/grokbotproduct-sf\nCo replied: Short notice, but Grok Bot x Notion is throwing a product builders night in SF on Tuesday the 29th.\nCo replied: https://x.com/i/status/2102773693290336381\nCo replied: Found the SF meetup you asked about: daytonaio's AI Builders Demo Night, Tuesday at WorkOS SF.\nCo replied: Does anything here catch your eye?",
    openItems: [
      { id: "offer_reaction:39", kind: "offer_reaction", description: 'Co offered "Grok Bot x Notion for Product Builders night (SF)"', askedAt: null },
      { id: "offer_reaction:38", kind: "offer_reaction", description: 'Co offered "daytonaio AI Builders Demo Night"', askedAt: null },
    ],
    want: (r) => r.moment.mode === "reacting" && r.router.answers?.itemId === "offer_reaction:39" && r.aboutSent?.startsWith("Grok"),
  },
  { name: "feedback", message: "We should find time and date for any event we surface", recent: "User said: Ok feedback for the team: if a X post contains a Luma url, gather all the details from luma\nCo replied: Makes sense, passed it along to the team.", want: (r) => r.feedback.length >= 1 && r.moment.mode === "feedback" },
  { name: "thanks", message: "thanks!", recent: "Co replied: Here's the link for Tuesday.", want: (r) => r.moment.mode === "small_talk" && r.moment.dots.length === 0 && !r.router.wantsRecommendation },
  { name: "sharing a feeling", message: "honestly this week has been rough, feel like I'm behind on everything with the launch", recent: "Co replied: How's the week shaping up?", want: (r) => r.emotion?.target === "life" && r.moment.mode === "sharing" },
];
let ok = 0;
for (const c of cases) {
  const r: any = await readTurn({ message: c.message, recentConversation: c.recent, openItems: c.openItems ?? [] }, ctx, null);
  const pass = c.want(r);
  if (pass) ok++;
  console.log(`${pass ? "ok  " : "MISS"} ${c.name} (${r.latencyMs}ms): mode=${r.moment.mode} topic="${r.moment.topic}" pushback=${JSON.stringify(r.moment.pushback)} lesson=${JSON.stringify(r.moment.lesson)} dots=${r.moment.dots.length} about=${JSON.stringify(r.aboutSent)} feedback=${JSON.stringify(r.feedback)} emotion=${JSON.stringify(r.emotion)} answers=${JSON.stringify(r.router.answers)} rec=${r.router.wantsRecommendation}`);
}
console.log(`real turns: ${ok}/${cases.length}`);
