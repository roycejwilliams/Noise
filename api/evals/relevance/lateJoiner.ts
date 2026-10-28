// The late-joiner gap and the 3am sweep's comment (Royce, 2026-10-17: "3am sweep: fix the outdated comment and the late-joiner
// matching gap"). A fresh ask makes its member findable by other members' standing asks; those asks now check that member right
// away (relevance.ts sweepStandingAsksForNewcomer) instead of only at the next 3am pass. Zero tokens: the scorers, the edge log and
// the database reads are stubs; invented people.
//   npx tsx evals/relevance/lateJoiner.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
import { readFileSync } from "fs";

const R = await import("../../src/services/relevance.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};

const EMB = [0.1, 0.2, 0.3];
const NEWCOMER = { user_id: "u-ellis", goals: ["open a ceramics studio"], intent: [{ id: "a-ellis", text: "can teach wheel throwing", type: "offering", status: "active", kind: "ask", embedding: EMB, shareable: true }] };
// What the database would hand back: Jordan's seeking ask, Noor's offering, a goal and a closed ask (never scored), and Ellis's own ask.
const STANDING: any[] = [
  { personId: "u-jordan", ask: { id: "a-jordan", text: "looking for someone to teach me pottery", type: "seeking", status: "active", kind: "ask", embedding: EMB }, askerContext: "goals: a new hobby" },
  { personId: "u-noor", ask: { id: "a-noor", text: "can lend kiln time", type: "offering", status: "active", kind: "ask", embedding: EMB } },
  { personId: "u-sarah", ask: { id: "g-sarah", text: "build a creative life", type: "seeking", status: "active", kind: "goal", embedding: EMB } },
  { personId: "u-milo", ask: { id: "a-milo", text: "find a studio", type: "seeking", status: "done", kind: "ask", embedding: EMB } },
  { personId: "u-ellis", ask: NEWCOMER.intent[0] },
];

function deps(o: { newcomer?: any; failOn?: string } = {}) {
  const seen = { limit: -1, seeking: [] as any[], offering: [] as any[], logged: [] as any[] };
  const score = (ask: any, cands: any[]) => {
    if (ask.id === o.failOn) throw new Error("scorer down");
    return cands.map((c) => ({ user_id: c.user_id, score: 80, reason: "r", shareReason: "s", mutual: false }));
  };
  const d: import("../../src/services/relevance.js").NewcomerSweepDeps = {
    newcomer: async () => (o.newcomer === undefined ? NEWCOMER : o.newcomer),
    standingAsksNear: async (_u, limit) => { seen.limit = limit; return STANDING; },
    scoreSeeking: async (ask, cands, ctx) => { seen.seeking.push({ ask: ask.id, cands: cands.map((c) => c.user_id), ctx }); return score(ask, cands); },
    scoreOffering: async (ask, cands) => { seen.offering.push({ ask: ask.id, cands: cands.map((c) => c.user_id) }); return score(ask, cands); },
    logEdges: async (personId, askId, askText, scored) => { seen.logged.push({ personId, askId, askText, candidates: scored.map((s) => s.user_id) }); },
  };
  return { d, seen };
}

// ---------------------------------------------------------------- 1. the standing asks meet the newcomer now
{
  const { d, seen } = deps();
  await R.sweepStandingAsksForNewcomer("u-ellis", d);
  check("a standing seeking ask is scored against the newcomer alone, with its asker's context", JSON.stringify(seen.seeking) === JSON.stringify([{ ask: "a-jordan", cands: ["u-ellis"], ctx: "goals: a new hobby" }]), seen.seeking);
  check("a standing offering is scored against the newcomer alone", JSON.stringify(seen.offering) === JSON.stringify([{ ask: "a-noor", cands: ["u-ellis"] }]), seen.offering);
  check("the edges are logged from the asker's side, so their tease and check-in read them", JSON.stringify(seen.logged) === JSON.stringify([
    { personId: "u-jordan", askId: "a-jordan", askText: "looking for someone to teach me pottery", candidates: ["u-ellis"] },
    { personId: "u-noor", askId: "a-noor", askText: "can lend kiln time", candidates: ["u-ellis"] },
  ]), seen.logged);
  check("a goal, a closed ask and the newcomer's own ask are never scored", ![...seen.seeking, ...seen.offering].some((c) => ["g-sarah", "a-milo", "a-ellis"].includes(c.ask)));
  check("capped: only the nearest few standing asks are read (one model call each)", seen.limit > 0 && seen.limit <= 5, seen.limit);
}
{
  const { d, seen } = deps({ newcomer: null });
  await R.sweepStandingAsksForNewcomer("u-gone", d);
  check("a member who isn't live (archived, opted out, no profile) is never scored", seen.seeking.length + seen.offering.length + seen.logged.length === 0, seen);
}
{
  const { d, seen } = deps({ failOn: "a-jordan" });
  await R.sweepStandingAsksForNewcomer("u-ellis", d);
  check("one ask's scorer failing doesn't stop the next", JSON.stringify(seen.logged.map((l) => l.askId)) === JSON.stringify(["a-noor"]), seen.logged);
}

// ---------------------------------------------------------------- 1b. each standing ask is scored as its asker's (review of #274, 2026-10-27)
// The prompt holds the asker's ask and context: it was filed under the newcomer whose turn started the sweep (their trace text,
// their cost), so the asker's removal never reached it, and the asker's own name wasn't left out of the newcomer's items.
{
  const T = await import("../../src/services/llmTraceText.js");
  const U = await import("../../src/services/llmUsage.js");
  const NEW = "11111111-1111-4111-8111-111111111111", ASKER = "22222222-2222-4222-8222-222222222222", OFFER = "33333333-3333-4333-8333-333333333333";
  const under: any[] = [];
  const d: import("../../src/services/relevance.js").NewcomerSweepDeps = {
    newcomer: async () => ({ ...NEWCOMER, user_id: NEW }),
    standingAsksNear: async () => [
      { personId: ASKER, ask: STANDING[0].ask, askerContext: "goals: a new hobby", askerFirstName: "Jordan" },
      { personId: OFFER, ask: STANDING[1].ask, askerFirstName: "Noor" },
    ],
    scoreSeeking: async (_a, c, _ctx, name) => { under.push({ trace: T.currentTraceUser(), member: U.scopeMember(), name }); return []; },
    scoreOffering: async (_a, c, name) => { under.push({ trace: T.currentTraceUser(), member: U.scopeMember(), name }); return []; },
    logEdges: async () => {},
  };
  await T.withTraceUser(NEW, () => U.withMember(NEW, () => R.sweepStandingAsksForNewcomer(NEW, d)));
  check("each standing ask is scored under its asker's trace mark and cost scope, never the newcomer's", JSON.stringify(under.map((u) => [u.trace, u.member])) === JSON.stringify([[ASKER, ASKER], [OFFER, OFFER]]), under);
  check("the asker's first name goes to the scorer, so it is left out of the newcomer's items (as the 3am pass does)", JSON.stringify(under.map((u) => u.name)) === JSON.stringify(["Jordan", "Noor"]), under);
}

// ---------------------------------------------------------------- 2. wired at capture, and the read matches the 3am pass
{
  const pe = src("services/profileExtraction.ts");
  check("a fresh ask runs the newcomer check right after the capture-time sweeps", /if \(fresh\.some\(\(r\) => r\.kind === "ask"\)\) \{\s*sweepStandingAsksForNewcomer\(user_id\)/.test(pe));
  const rel = src("services/relevance.ts");
  const near = rel.slice(rel.indexOf("standingAsksNear: async"), rel.indexOf("scoreSeeking: async"));
  check("the standing-ask read skips the newcomer, keeps live members only, and reads open asks with an embedding",
    /WHERE cp\.user_id != \$1/.test(near) && /u\.archived_at IS NULL AND COALESCE\(u\.sms_opted_out, false\) = false/.test(near) && /COALESCE\(a\.entry->>'kind', 'ask'\) = 'ask'/.test(near) && /jsonb_typeof\(a\.entry->'embedding'\) = 'array'/.test(near) && /ORDER BY dist/.test(near));
}

// ---------------------------------------------------------------- 3. the 3am comment says what's true
{
  const jobs = src("jobs/index.ts");
  const at = jobs.indexOf('cron.schedule("0 3 * * *"');
  const comment = jobs.slice(jobs.lastIndexOf("Co Loop Stage 3", at), at);
  check("the 3am comment no longer says nothing downstream reads relevance_edges", !/nothing\s+(\/\/\s*)?downstream acts on relevance_edges/.test(comment) && !/Density-phase only/.test(comment), comment);
  check("the 3am comment names its readers (the network tease and the ask check-in) and the newcomer path",
    /findFreshCandidates/.test(comment) && /check-in/.test(comment) && /sweepStandingAsksForNewcomer/.test(comment), comment);
}

console.log(`${total - failed}/${total} late-joiner checks passed`);
if (failed) process.exit(1);
