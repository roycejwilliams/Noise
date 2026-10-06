// Does Jev pruning keep the people Claude would match? (Ported 2026-09-25 to the
// zero-retention gateway, services/jevMatching.ts.) Invented guest list only, so no member
// data leaves the machine. The true matches are fixed below BEFORE either model runs.
//
//   railway run --service co-test --environment dev -- npx tsx evals/jev/matchingPrune.ts
//
// Measures: recall of true matches after pruning (must be 100%: a dropped match is lost),
// how many candidates Claude no longer has to read, and time for each stage.
import "../lib/requireMeter.js";
import "dotenv/config";
import { scoreAgainstStatedAsk } from "../../src/services/matching.js";
import { jevMatchScores, keepAfterPrune } from "../../src/services/jevMatching.js";
import { gatewayConfigured } from "../../src/services/jevGateway.js";

type G = { id: string; goals?: string[]; activity_preferences?: string[]; ask?: [string, "seeking" | "offering"] };
const G: G[] = [
  { id: "g0", goals: ["Staff engineer, 6 years at Google on search infrastructure"], ask: ["a startup to join as an early engineer", "seeking"] },
  { id: "g1", goals: ["Ex-Stripe payments engineer, now freelancing"] },
  { id: "g2", goals: ["Backend engineer at Meta on ads"] },
  { id: "g3", goals: ["Engineer at Amazon on logistics"] },
  { id: "g4", goals: ["Partner at a climate-focused venture fund, invests seed to Series A"] },
  { id: "g5", goals: ["Angel investor, mostly climate and energy startups"] },
  { id: "g6", goals: ["Partner at a healthcare venture fund"] },
  { id: "g7", goals: ["Angel investor in consumer apps"] },
  { id: "g8", goals: ["Senior product designer at Figma, mobile apps"], ask: ["design advice for founders", "offering"] },
  { id: "g9", goals: ["Freelance UI/UX designer, consumer mobile apps"] },
  { id: "g10", goals: ["Backend developer learning design"] },
  { id: "g11", goals: ["Graphic designer for print and packaging"] },
  { id: "g12", goals: ["Robotics engineer, built drone controllers; looking for a cofounder for a hardware startup"] },
  { id: "g13", goals: ["Mechanical engineer, hardware prototyping, wants to start a robotics company"], ask: ["a software cofounder", "seeking"] },
  { id: "g14", goals: ["Software engineer at a fintech"] },
  { id: "g15", goals: ["Product manager at a SaaS company"] },
  { id: "g16", goals: ["First-time founder building a fintech app, launched two months ago"] },
  { id: "g17", goals: ["First-time founder, building a food delivery tool, pre-seed"] },
  { id: "g18", goals: ["Serial founder, three exits"] },
  { id: "g19", goals: ["Founder, second company"] },
  { id: "g20", activity_preferences: ["trail running", "weekend hikes"] },
  { id: "g21", activity_preferences: ["hiking", "climbing"] },
  { id: "g22", activity_preferences: ["yoga", "pottery"] },
  { id: "g23", activity_preferences: ["cycling"] },
  { id: "g24", goals: ["Research scientist working on large language models at a lab"] },
  { id: "g25", goals: ["PhD student in machine learning, reinforcement learning"] },
  { id: "g26", goals: ["Data analyst at a retailer"] },
  { id: "g27", goals: ["Software engineer using AI APIs"] },
  { id: "g28", goals: ["Growth marketer who scaled a consumer app from 0 to 3M users"] },
  { id: "g29", goals: ["Head of growth at a B2C subscription app"] },
  { id: "g30", goals: ["B2B enterprise sales lead"] },
  { id: "g31", goals: ["Brand designer and social media manager"] },
  { id: "g32", goals: ["Nurse, wants to meet people who like board games"] },
  { id: "g33", goals: ["Teacher, learning to cook"] },
  { id: "g34", goals: ["Accountant, looking for a book club"] },
  { id: "g35", goals: ["Lawyer, moving to SF next month"] },
  { id: "g36" },
  { id: "g37" },
  { id: "g38", goals: ["Photographer, freelance weddings"] },
  { id: "g39", goals: ["Chef at a restaurant, wants to open a food truck"] },
];
const ASKS: [string, string[]][] = [
  ["Looking for ex-Google or ex-Stripe engineers to build with", ["g0", "g1"]],
  ["Want to meet climate tech investors", ["g4", "g5"]],
  ["Looking for a product designer for my consumer app", ["g8", "g9"]],
  ["I need a robotics or hardware cofounder", ["g12", "g13"]],
  ["Looking for other first-time founders to swap notes with", ["g16", "g17"]],
  ["Want to find people who run or hike on weekends", ["g20", "g21"]],
  ["Looking for an AI researcher to advise us", ["g24", "g25"]],
  ["Want to meet growth marketers who've scaled consumer apps", ["g28", "g29"]],
];
const cand = G.map((g) => ({ user_id: g.id, goals: g.goals, activity_preferences: g.activity_preferences, intent: g.ask ? [{ id: g.id, text: g.ask[0], type: g.ask[1], status: "active" }] : undefined }));

async function main() {
  if (!gatewayConfigured()) { console.log("No gateway key here. Run through `railway run`."); process.exit(2); }
  process.env.JEV_PRUNE = "off"; // the "full" pass below must not prune
  let truth = 0, kept = 0, keptTotal = 0, claudeTop2Full = 0, claudeTop2Pruned = 0, jevMs = 0, fullMs = 0, prunedMs = 0;
  for (const [ask, want] of ASKS) {
    const t0 = Date.now();
    const full = await scoreAgainstStatedAsk({ id: "a", text: ask, type: "seeking", status: "active" }, cand);
    fullMs += Date.now() - t0;
    const top2 = (rs: typeof full) => [...rs].sort((a, b) => b.score - a.score).slice(0, 2).map((r) => r.candidate.user_id);
    claudeTop2Full += top2(full).filter((id) => want.includes(id)).length;

    const t1 = Date.now();
    const ps = await jevMatchScores(ask, cand);
    jevMs += Date.now() - t1;
    const keep = keepAfterPrune(ps);
    const keptIds = keep.map((i) => cand[i].user_id);
    keptTotal += keep.length;
    truth += want.length;
    const lost = want.filter((id) => !keptIds.includes(id));
    kept += want.length - lost.length;
    const t2 = Date.now();
    const pruned = keep.length ? await scoreAgainstStatedAsk({ id: "a", text: ask, type: "seeking", status: "active" }, keep.map((i) => cand[i])) : [];
    prunedMs += Date.now() - t2;
    claudeTop2Pruned += top2(pruned).filter((id) => want.includes(id)).length;
    console.log(`${ask.slice(0, 52).padEnd(52)} kept ${String(keep.length).padStart(2)}/${cand.length} | true matches kept ${want.length - lost.length}/${want.length}${lost.length ? ` LOST ${lost.join(",")}` : ""}`);
  }
  console.log(`\nrecall after pruning: ${kept}/${truth} true matches kept`);
  console.log(`Claude reads ${Math.round((keptTotal / (ASKS.length * cand.length)) * 100)}% of the candidates it would have read (${keptTotal} vs ${ASKS.length * cand.length})`);
  console.log(`Claude top-2 correct: full ${claudeTop2Full}/${truth}, after pruning ${claudeTop2Pruned}/${truth}`);
  console.log(`time per ask: Jev stage ${Math.round(jevMs / ASKS.length)}ms + Claude on the rest ${Math.round(prunedMs / ASKS.length)}ms, vs Claude on everyone ${Math.round(fullMs / ASKS.length)}ms`);
  process.exit(0);
}
main();
