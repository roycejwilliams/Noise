// The room frame comes from the situation, never from a goal on its own (Royce, 2026-10-18, permanent: "The situation decides what Cue
// looks for and which helpers run. What we know about a member shapes how, never which helper."). Before: a member with no ask for the
// night was scored against their newest goal (eventScoring.ts `getActiveSeekingAsk ?? getGoalFrame ?? getActiveOfferingAsk`,
// matching.ts roomFrame), so what Cue knew about them picked what the room was searched for. Now: what they said they're looking for
// or can offer is the frame; with none, they're asked what they'd like from the room, like anyone with no ask (the existing ask
// solicitation, unchanged), and no match is forced. A goal still rides along with an ask (how it's judged and said), as before.
// Runs the REAL scoring pass on the in-room fake world (evals/inroom/world.ts). Invented people, test-range numbers, zero tokens.
//   npx tsx evals/matching/roomFrameSituation.ts
import { readFileSync } from "fs";
import { W, reset, addMember, addEvent, ask, goal, check, results, type Member } from "../inroom/world.js";

// The clock is pinned to 18:00 UTC, as evals/inroom/flow.ts (members with no zone may be texted 16:00-24:00 UTC).
{
  const RealDate = Date;
  const pinned = new RealDate();
  pinned.setUTCHours(18, 0, 0, 0);
  const offset = pinned.getTime() - RealDate.now();
  class PinnedDate extends RealDate {
    constructor(...a: any[]) {
      super(...((a.length ? a : [RealDate.now() + offset]) as [any]));
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  (globalThis as any).Date = PinnedDate;
}

const M = await import("../../src/services/matching.js");
const S = await import("../../src/services/eventScoring.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const settle = () => new Promise((r) => setTimeout(r, 30));
const freshPass = async (ev: string) => {
  W.scoringDebounce.clear();
  const r = await S.scoreGuestListForEvent(ev);
  await settle();
  return r;
};
const nudgeOf = (ev: string, m: Member) => W.nudges.find((n) => n.event_id === ev && n.person_id === m.id);
// The frame line each scoring call was asked about (the scorer prompt quotes it first).
const frames = () => W.llmCalls.filter((c) => c.kind === "score").map((c) => c.prompt.match(/match this: "([\s\S]*?)"\n/)?.[1] ?? "");
const scorePromptFor = (askText: string) => W.llmCalls.find((c) => c.kind === "score" && (c.prompt.match(/match this: "([\s\S]*?)"\n/)?.[1] ?? "").includes(askText))?.prompt ?? "";

// ================================================================ 1. the frame itself
{
  const G = "Meet people building consumer social";
  check("no ask, only a goal: no frame (the goal never picks what the room is searched for)", (await M.roomFrame([goal(G)])) === null);
  check("nothing on file: no frame", (await M.roomFrame([])) === null && (await M.roomFrame(null)) === null);
  const withAsk = await M.roomFrame([ask("a technical cofounder"), goal(G)]);
  check("with an ask: unchanged, the ask is the frame and the goal rides along as where they're headed", withAsk?.asks.map((a) => a.text).join() === "a technical cofounder" && withAsk?.goal?.text === G && M.frameLine(withAsk!) === `looking for: a technical cofounder | headed toward: ${G}`, withAsk);
  const offering = await M.roomFrame([ask("seed checks for climate founders", "offering")]);
  check("with only an offering: unchanged, it names who they're there for", offering?.asks[0]?.text === "seed checks for climate founders" && offering?.goal === null);
}

// ================================================================ 2. the night: no ask for the night -> the situation decides
{
  reset();
  const jordan = addMember({ first_name: "Jordan", intent: [ask("an angel investor in edtech")] });
  const noor = addMember({ first_name: "Noor", intent: [goal("invest in early edtech founders")] });
  const ellis = addMember({ first_name: "Ellis", intent: [ask("a designer for a consumer app"), goal("launch a consumer social app")] });
  addEvent({ api_id: "evt-frame", name: "Cue Night" }, [{ m: jordan }, { m: noor }, { m: ellis }]);
  W.scorer = (askText, cand) => ({ score: /angel investor/.test(askText) && cand.first_name === "Noor" ? 92 : /invest in early edtech/.test(askText) && cand.first_name === "Jordan" ? 90 : 0, share: true });
  const r = await freshPass("evt-frame");
  check("Noor (only a goal) is not scored against her goal: no ranking, and no frame quotes it", !W.rankings.has(`evt-frame|${noor.id}`) && !frames().some((f) => /invest in early edtech/.test(f)), frames());
  check("... she's asked what she'd like from the room, like anyone with no ask (the ask solicitation, unchanged)", W.candidates.some((c) => c.user_id === noor.id && c.type === "ask_solicitation") && r.solicitedCount === 1, { r, cands: W.candidates.map((c) => [c.user_id === noor.id ? "Noor" : c.user_id, c.type]) });
  check("... and no nudge is picked for her by her goal", !nudgeOf("evt-frame", noor));
  check("Jordan (an ask) is scored against his ask, as before, with Noor among his candidates", W.rankings.has(`evt-frame|${jordan.id}`) && /Noor|tag/.test(scorePromptFor("an angel investor in edtech")) && frames().includes("looking for: an angel investor in edtech"));
  const ep = scorePromptFor("a designer for a consumer app");
  check("Ellis (an ask and a goal): unchanged, the ask is the frame, the goal rides along, and it shapes how he's judged (what's known about him)", W.rankings.has(`evt-frame|${ellis.id}`) && frames().includes("looking for: a designer for a consumer app | headed toward: launch a consumer social app") && /What's known about the person asking[^\n]*goals: launch a consumer social app/.test(ep), ep.slice(0, 400));
}

// ================================================================ 3. never force a match: a room of goals only stays quiet
{
  reset();
  const a = addMember({ first_name: "Sarah", intent: [goal("raise a pre-seed round")] });
  const b = addMember({ first_name: "Ellis", intent: [goal("back pre-seed founders")] });
  addEvent({ api_id: "evt-goals", name: "Cue Night" }, [{ m: a }, { m: b }]);
  W.scorer = () => ({ score: 95, share: true });
  const r = await freshPass("evt-goals");
  check("a room where nobody said what they want for the night: nobody is scored, no nudge, no match; each is only asked", r.scoredCount === 0 && W.nudges.length === 0 && W.rankings.size === 0 && W.candidates.length === 2 && W.candidates.every((c) => c.type === "ask_solicitation"), { r, nudges: W.nudges.length, cands: W.candidates.map((c) => c.type) });
}

// ================================================================ 4. pinned in the source
{
  const es = src("services/eventScoring.ts");
  check("the gate for a frame is an ask (seeking, else offering), never a goal", /const ask = getActiveSeekingAsk\(person\.intent\) \?\? getActiveOfferingAsk\(person\.intent\);/.test(es) && !/getGoalFrame/.test(es));
  check("roomFrame has no frame without an ask about people", /const asks = await peopleAsksOf\(open\);\n  if \(!asks\.length\) return null;/.test(src("services/matching.ts")));
}

console.log(`\nroom frame from the situation: ${results.total - results.failed}/${results.total} passed`);
process.exit(results.failed ? 1 : 0);
