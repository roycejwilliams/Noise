// In-room match QUALITY on synthetic rooms (analysis/in-room-matching, 2026-10-07). METERED: real scoring model calls.
// Runs the production scorer (matching.ts scoreAgainstStatedAsk, the exact prompt scoreMatchedGroup uses) for every
// asker in invented rooms with planted ground truth, then applies the same nudge rule as eventScoring.ts
// (top-1, score >= MATCH_NUDGE_MIN_SCORE, non-empty shareReason).
//
//   EVAL_REAL_MODELS=1 EVAL_COST_CAP_USD=1.5 EVAL_TOKEN_CAP=200000 npm run eval:live -- evals/inroom/quality.ts
// No DB (no embeddings on the asks, Jev prune off), no texts. Invented people only.
import "../lib/requireMeter.js";
import "dotenv/config";
process.env.JEV_PRUNE = "off";
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async () => ({ rows: [], rowCount: 0 });
const { scoreAgainstStatedAsk, getActiveSeekingAsk, getGoalFrame } = await import("../../src/services/matching.js");
const { goalTexts } = await import("../../src/services/goalJourney.js");

type P = { user_id: string; first_name: string; goals?: string[]; blockers?: string[]; activity_preferences?: string[]; intent: any[]; truth?: string | null };
const a = (text: string, type: "seeking" | "offering" = "seeking") => ({ text, type, status: "active", kind: "ask" });
const g = (text: string) => ({ text, type: "seeking", status: "active", kind: "goal" });
let n = 0;
const P = (first_name: string, intent: any[], truth: string | null | undefined, extra: Partial<P> = {}): P => ({ user_id: `u${++n}`, first_name, intent, truth, ...extra });

const rooms: { name: string; people: P[] }[] = [
  {
    name: "Founders supper (planted pairs + distractors)",
    people: [
      P("Jordan", [a("a seed investor who backs climate hardware")], "Ellis"),
      P("Ellis", [a("seed checks for climate and hardware founders", "offering")], undefined, { goals: ["back 10 climate companies this year"] }),
      P("Noor", [a("a technical cofounder who has shipped ML in production")], "Priya"),
      P("Priya", [a("joining an early startup as a technical cofounder")], "Noor", { goals: ["start something in applied ML"], activity_preferences: ["built ML ranking systems at a large company"] }),
      P("Sarah Hao", [a("a product designer to redo our onboarding")], "Marcus"),
      P("Marcus", [a("freelance product design for early-stage apps", "offering")]),
      P("Tomas", [a("people who host community events in SF")], "Lena"),
      P("Lena", [a("co-hosts for a monthly founder dinner in SF")], "Tomas"),
      P("Ravi", [a("advice on hiring our first enterprise sales lead")], null),
      P("Dana", [g("invest in early climate companies")], "Ellis"),
      P("Kai", [a("angel checks into hardware startups", "offering"), a("a pediatric dentist in Oakland")], undefined),
    ],
  },
  {
    name: "Near misses (similar words, wrong fit)",
    people: [
      P("Avery", [a("a seed investor for a climate hardware company")], "Quinn"),
      P("Blake", [a("Series B growth equity for climate fintech", "offering")], undefined),
      P("Quinn", [a("pre-seed checks for deep tech hardware", "offering")], undefined),
      P("Casey", [a("a React Native contractor for two months")], "Rowan"),
      P("Rowan", [a("mobile app contract work", "offering")], undefined),
      P("Morgan", [a("a native Spanish speaker to practice with")], null),
      P("Harper", [a("a frontend engineer to join full time as employee #3", "offering")], undefined),
    ],
  },
  {
    name: "Unrelated room (nothing should clear the bar)",
    people: [
      P("Ellis", [a("a climbing partner for weekday mornings")], null),
      P("Noor", [a("a ceramics studio to share")], null),
      P("Jordan", [a("a Mandarin tutor")], null),
      P("Sarah Hao", [a("a buyer for a vintage motorcycle")], null),
      P("Tomas", [a("someone to review my novel draft")], null),
    ],
  },
];

const MIN = 60;
let truthCases = 0, top1 = 0, nudgedCorrect = 0, nudgedWrong = 0, fpNoTruth = 0, noTruthCases = 0, missedBecauseUnshareable = 0, belowBar = 0;
const lines: string[] = [];
for (const room of rooms) {
  lines.push(`\n## ${room.name}`);
  for (const person of room.people) {
    const ask = getActiveSeekingAsk(person.intent) ?? getGoalFrame(person.intent);
    if (!ask?.text) {
      lines.push(`${person.first_name}: no seeking ask/goal -> would be solicited, not scored`);
      continue;
    }
    const others = room.people.filter((o) => o.user_id !== person.user_id);
    const ctx = [goalTexts(person.intent, person.goals).length ? `goals: ${goalTexts(person.intent, person.goals).join(", ")}` : null].filter(Boolean).join("; ") || undefined;
    const scored = (await scoreAgainstStatedAsk(ask, others, ctx)).sort((x, y) => y.score - x.score);
    const top = scored[0];
    const topName = top?.candidate.first_name;
    const fires = !!top && top.score >= MIN && !!top.shareReason;
    const best3 = scored.slice(0, 3).map((s) => `${s.candidate.first_name} ${s.score}${s.shareReason ? "" : "(no share)"}`).join(", ");
    lines.push(`${person.first_name} ("${ask.text}") -> ${best3}${fires ? `  => NUDGE about ${topName}: ${top.shareReason}` : "  => no nudge"}`);
    if (person.truth) {
      truthCases++;
      if (topName === person.truth) top1++;
      if (fires && topName === person.truth) nudgedCorrect++;
      else if (fires) nudgedWrong++;
      else if (top && top.score >= MIN && !top.shareReason) missedBecauseUnshareable++;
      else belowBar++;
    } else if (person.truth === null) {
      noTruthCases++;
      if (fires) fpNoTruth++;
    }
  }
}
console.log(lines.join("\n"));
console.log(`\nQUALITY: top-1 = truth ${top1}/${truthCases}; nudge sent and right ${nudgedCorrect}/${truthCases}; nudge sent and wrong ${nudgedWrong}; strong but unshareable ${missedBecauseUnshareable}; below bar ${belowBar}; false nudges where nobody fits ${fpNoTruth}/${noTruthCases}`);
process.exit(0);
