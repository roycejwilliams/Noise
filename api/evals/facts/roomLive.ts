// Does the people graph find who in a room is worth whom, and does it help
// the scorer? (2026-09-26.) An invented room of ten, with a few planted good
// pairs among near-misses. Real Haiku reads and embeddings, real Sonnet
// scoring with and without the graph's hints. Nothing is written.
//
//   railway run --service co-test --environment dev -- npx tsx evals/facts/roomLive.ts [runs]
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.JEV_PRUNE = "off"; // a room of ten: the scorer reads everyone either way
const { readWantsOffers, bestEdges, edgeHint } = await import("../../src/services/peopleGraph.js");
const { generateEmbeddings } = await import("../../src/services/embeddings.js");
const { scoreAgainstStatedAsk } = await import("../../src/services/matching.js");

type P = { id: string; name: string; work: string; goals: string[]; ask: string | null; offering?: string };
const ROOM: P[] = [
  { id: "noor", name: "Noor", work: "solo founder of an early climate data startup, non-technical, ex-consultant", goals: ["ship an MVP by December"], ask: "a technical cofounder who can build data pipelines" },
  { id: "ellis", name: "Ellis", work: "senior data engineer at a logistics company, builds streaming pipelines, wants to leave and start something", goals: ["join an early-stage climate company"], ask: "an early founder working on climate who needs an engineer" },
  { id: "jordan", name: "Jordan", work: "product designer, freelances for seed-stage startups", goals: ["find two new design clients"], ask: "seed-stage founders who need a product designer" },
  { id: "sarah", name: "Sarah Hao", work: "founder of a B2B payments startup, pre-seed, has a rough prototype with an ugly UI", goals: ["redesign onboarding before fundraising"], ask: "a product designer who has worked with fintech" },
  { id: "maya", name: "Maya", work: "angel investor, former operator at a fintech, writes small first checks", goals: ["meet pre-seed B2B founders"], ask: "pre-seed B2B software founders raising a first round" },
  { id: "theo", name: "Theo", work: "runs a monthly supper club for creatives in the Mission", goals: ["find a new venue"], ask: "a restaurant or space that hosts private dinners" },
  { id: "priya", name: "Priya", work: "ML researcher, just moved to SF from Boston, knows no one here", goals: ["make friends outside work"], ask: "people to go climbing with on weekends" },
  { id: "sam", name: "Sam", work: "backend engineer at a big tech company, climbs three times a week", goals: ["get better at outdoor climbing"], ask: "a climbing partner for weekend trips" },
  { id: "lena", name: "Lena", work: "frontend engineer, React, happy at her job", goals: ["speak at a conference"], ask: "people organizing tech meetups who need speakers" },
  { id: "omar", name: "Omar", work: "pastry chef opening a bakery in the Mission", goals: ["find investors for the bakery"], ask: "people who invest in restaurants" },
];
// The planted "should connect" answers (either direction).
const EXPECT: Record<string, string[]> = { noor: ["ellis"], sarah: ["jordan", "maya"], priya: ["sam"], jordan: ["sarah"], ellis: ["noor"], sam: ["priya"] };

const cos = (a: number[], b: number[]) => {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return d / Math.sqrt(x * y);
};

const runs = Number(process.argv[2] ?? 1);
let graphHits = 0, graphTotal = 0, plainTop = 0, hintedTop = 0, scoredAskers = 0;
for (let run = 0; run < runs; run++) {
  const wo = await Promise.all(ROOM.map((p) => readWantsOffers({ firstName: p.name, work: p.work, wantsNow: [], valuesInPeople: [], goals: p.goals, lifeChapters: [], findAsks: p.ask ? [p.ask] : [], offering: p.offering ?? null })));
  const facts: { owner: string; relation: "wants" | "offers"; label: string }[] = [];
  ROOM.forEach((p, i) => {
    for (const w of wo[i]?.wants ?? []) facts.push({ owner: p.id, relation: "wants", label: w });
    for (const o of wo[i]?.offers ?? []) facts.push({ owner: p.id, relation: "offers", label: o });
  });
  if (run === 0) for (const p of ROOM) console.log(`${p.id.padEnd(7)} wants: ${facts.filter((f) => f.owner === p.id && f.relation === "wants").map((f) => f.label).join("; ")}\n        offers: ${facts.filter((f) => f.owner === p.id && f.relation === "offers").map((f) => f.label).join("; ")}`);
  const vecs = await generateEmbeddings(facts.map((f) => f.label));
  const pairs: { wantOwner: string; offerOwner: string; want: string; offer: string; sim: number }[] = [];
  facts.forEach((w, i) => {
    if (w.relation !== "wants") return;
    facts.forEach((o, j) => {
      if (o.relation !== "offers" || o.owner === w.owner) return;
      pairs.push({ wantOwner: w.owner, offerOwner: o.owner, want: w.label, offer: o.label, sim: cos(vecs[i], vecs[j]) });
    });
  });

  for (const [asker, expected] of Object.entries(EXPECT)) {
    const edges = bestEdges(asker, pairs);
    const top = [...edges.values()].sort((a, b) => b.score - a.score).slice(0, 2).map((e) => e.candidateId);
    graphTotal++;
    const hit = expected.some((x) => top.includes(x));
    if (hit) graphHits++;
    if (run === 0) console.log(`graph  ${asker.padEnd(7)} top: ${[...edges.values()].sort((a, b) => b.score - a.score).slice(0, 3).map((e) => `${e.candidateId} ${e.score}`).join(", ")}  ${hit ? "ok" : "MISS"}`);

    // Scoring with and without the graph's hints.
    const me = ROOM.find((p) => p.id === asker)!;
    if (!me.ask) continue;
    const others = ROOM.filter((p) => p.id !== asker).map((p) => ({ user_id: p.id, goals: [p.work, ...p.goals], intent: p.ask ? [{ type: "seeking", text: p.ask, status: "active" }] : [] }));
    const hints = new Map<string, string>();
    for (const [id, e] of edges) { const h = edgeHint(e); if (h) hints.set(id, h); }
    const [plain, hinted] = await Promise.all([
      scoreAgainstStatedAsk({ text: me.ask, type: "seeking" } as any, others, `work: ${me.work}`),
      scoreAgainstStatedAsk({ text: me.ask, type: "seeking" } as any, others, `work: ${me.work}`, hints),
    ]);
    const best = (r: any[]) => [...r].sort((a, b) => b.score - a.score)[0]?.candidate.user_id;
    scoredAskers++;
    if (expected.includes(best(plain))) plainTop++;
    if (expected.includes(best(hinted))) hintedTop++;
    if (run === 0) console.log(`score  ${asker.padEnd(7)} plain top: ${best(plain)}  hinted top: ${best(hinted)}  (want ${expected.join("/")})`);
  }
}
console.log(`\ngraph found a planted pair in its top 2: ${graphHits}/${graphTotal}`);
console.log(`scorer top pick is a planted pair: plain ${plainTop}/${scoredAskers}, with graph hints ${hintedTop}/${scoredAskers}`);
