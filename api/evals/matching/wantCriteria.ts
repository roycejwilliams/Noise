// Match on meaning and evidence, not labels (Royce's spec, 2026-11-02, sections 2 and 6). A member's conditions on a want change who
// is picked, for that want only; a requirement nobody can confirm stays uncertain (never a match, never assumed); a preference moves
// the order without ruling anyone in or out; a thin room stays silent; the asker's conditions never reach the other member.
// Before: the room and network scorers saw only the want's text, so "not investors right now" said as its own message changed nothing,
// and a scorer that guessed could put anyone over the bar. Now: each want's conditions are listed to the scorer, it says per candidate
// whether each holds (yes / no / unknown), and code applies them (services/wantCriteria.ts applyConditions, matching.ts runAskScoring).
// Runs the REAL room scoring pass and the real network scorer on the in-room fake world (evals/inroom/world.ts). Invented people,
// test-range numbers, zero tokens.
//   npx tsx evals/matching/wantCriteria.ts
import { W, reset, addMember, addEvent, ask, check, results, type Member } from "../inroom/world.js";

// Pinned to 18:00 UTC, as evals/matching/roomFrameSituation.ts (members with no zone may be texted 16:00-24:00 UTC).
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

const WC = await import("../../src/services/wantCriteria.js");
const M = await import("../../src/services/matching.js");
const S = await import("../../src/services/eventScoring.js");
const settle = () => new Promise((r) => setTimeout(r, 30));
const pass = async (ev: string) => {
  W.scoringDebounce.clear();
  const r = await S.scoreGuestListForEvent(ev);
  await settle();
  return r;
};
const at = "2026-11-03T00:00:00.000Z";
const crit = (text: string, strength: "must" | "must_not" | "prefer", quote: string) => ({ text, strength, quote, at });
const nudgedTo = (ev: string, m: Member) => W.nudges.filter((n) => n.event_id === ev && n.person_id === m.id).map((n) => n.candidate_id);
const ranking = (ev: string, m: Member): any[] => (W.rankings.get(`${ev}|${m.id}`) as any)?.ranked_candidates ?? [];

const COFOUNDER = "a technical cofounder who's built consumer before";
const OUTSIDE = "people outside tech";
const NOT_INVESTORS = "I'm not looking for investors right now";
const TASTE = "taste matters more than seniority";

// ================================================================ 1. the pure rules
{
  const wants = [
    { label: "W1", text: COFOUNDER, criteria: [crit("investors", "must_not", NOT_INVESTORS), crit("has built a consumer product", "must", "who's built consumer before")] },
    { label: "W2", text: OUTSIDE, criteria: [] },
  ];
  const r = (conditions: [string, string][], fits: string[] = []) => WC.applyConditions(80, { conditions: conditions.map(([label, holds]) => ({ label, holds })), fits }, wants);
  check("an exclusion that holds takes that want out: fit only through it -> 0", r([["C1", "yes"], ["C2", "yes"]], ["W1"]).score === 0);
  check("... but only that want: the same candidate fitting the other want too keeps the score", r([["C1", "yes"], ["C2", "yes"]], ["W1", "W2"]).score === 80);
  check("a requirement that fails takes that want out", r([["C1", "no"], ["C2", "no"]], ["W1"]).score === 0);
  check("a requirement nobody can confirm: below the bar, never a match, never assumed", r([["C1", "no"], ["C2", "unknown"]], ["W1"]).score === WC.CONDITION_BAR - 1 && r([["C1", "no"], ["C2", "unknown"]], ["W1"]).unverified.length === 1);
  check("an answer with no read of a requirement is the same as unknown (fail closed)", r([], ["W1"]).score === WC.CONDITION_BAR - 1);
  check("an exclusion nobody can confirm is not invented: the want stays", r([["C1", "unknown"], ["C2", "yes"]], ["W1"]).score === 80);
  check("both met: unchanged", r([["C1", "no"], ["C2", "yes"]], ["W1"]).score === 80);
  const pref = [{ label: "W1", text: COFOUNDER, criteria: [crit("strong taste", "prefer", TASTE)] }];
  const p = (score: number, holds: string) => WC.applyConditions(score, { conditions: [{ label: "C1", holds }] }, pref).score;
  check("a preference moves the order a little, never across the bar either way", p(70, "yes") === 80 && p(70, "no") === WC.CONDITION_BAR && p(55, "yes") === WC.CONDITION_BAR - 1 && p(55, "no") === 45 && p(70, "unknown") === 70);
  check("no conditions: the score is the scorer's, untouched", WC.applyConditions(73, {}, [{ label: "W1", text: OUTSIDE, criteria: [] }]).score === 73);
  check("the bar is the one both nudge paths use", S.MATCH_NUDGE_MIN_SCORE === WC.CONDITION_BAR && /const NETWORK_NUDGE_MIN_SCORE = 60;/.test((await import("node:fs")).readFileSync(new URL("../../src/services/networkIntroNudge.ts", import.meta.url), "utf8")));
}

// ================================================================ 2. a room: the conditions change who is picked
const jordanIntent = () => [
  { ...ask(COFOUNDER), criteria: [crit("investors", "must_not", NOT_INVESTORS), crit("has built a consumer product", "must", "who's built consumer before")] },
  ask(OUTSIDE),
];
{
  reset();
  const jordan = addMember({ first_name: "Jordan", intent: jordanIntent() });
  const noor = addMember({ first_name: "Noor", intent: [ask("angel checks for consumer founders", "offering")] });
  const ellis = addMember({ first_name: "Ellis", intent: [ask("a cofounder to build with", "seeking")] });
  const sam = addMember({ first_name: "Sam", intent: [ask("a cofounder for my next consumer app", "seeking")] });
  addEvent({ api_id: "evt-c", name: "Cue Night" }, [{ m: jordan }, { m: noor }, { m: ellis }, { m: sam }]);
  // What the scorer reads on each line (a fixture): Noor is the strongest fit on words but is an investor; Ellis fits but nothing on
  // file says whether he's built consumer; Sam fits and has.
  W.scorer = (askText, cand) => {
    if (!askText.includes(COFOUNDER)) return { score: 0, share: false };
    if (cand.first_name === "Noor") return { score: 95, share: true, fits: [COFOUNDER], conditions: { investors: "yes", "has built a consumer product": "yes" } };
    if (cand.first_name === "Ellis") return { score: 90, share: true, fits: [COFOUNDER], conditions: { investors: "no", "has built a consumer product": "unknown" } };
    if (cand.first_name === "Sam") return { score: 75, share: true, fits: [COFOUNDER], conditions: { investors: "no", "has built a consumer product": "yes" } };
    return { score: 0, share: false };
  };
  await pass("evt-c");
  const prompt = W.llmCalls.find((c) => c.kind === "score" && c.prompt.includes(COFOUNDER))?.prompt ?? "";
  check("the scorer is shown each want labelled and its conditions labelled for that want only", /- W1 looking for: "a technical cofounder who's built consumer before"/.test(prompt) && /- W2 looking for: "people outside tech"/.test(prompt) && /C1 \(for W1\), must not: "investors"/.test(prompt) && /C2 \(for W1\), must: "has built a consumer product"/.test(prompt) && /"unknown" is the honest answer/.test(prompt), prompt.slice(0, 900));
  check("before: Noor (95) would have been the pick; now the investor is out, Ellis (unconfirmed) is held, and Sam is the one nudged", JSON.stringify(nudgedTo("evt-c", jordan)) === JSON.stringify([sam.id]), { nudged: nudgedTo("evt-c", jordan).map((id) => W.members.get(id)?.first_name), ranking: ranking("evt-c", jordan) });
  const rk = ranking("evt-c", jordan) as any[];
  const scoreOf = (m: Member) => rk.find((x) => x.candidate_id === m.id)?.score;
  check("... stored ranking: Noor 0, Ellis under the bar, Sam at his own score", scoreOf(noor) === 0 && scoreOf(ellis) === WC.CONDITION_BAR - 1 && scoreOf(sam) === 75, rk.map((x) => [W.members.get(x.candidate_id)?.first_name, x.score]));
  // Nothing of Jordan's conditions reaches anyone else: no other member's scoring prompt, no draft, no text. (The want itself,
  // "a technical cofounder who's built consumer before", is a shared ask: its words may be shown, as before.)
  const others = W.llmCalls.filter((c) => !(c.kind === "score" && c.prompt.includes(COFOUNDER)));
  const leaks = [...others.map((c) => c.prompt), ...W.sent.map((s) => s.content)].filter((t) => /not looking for investors|investors right now|has built a consumer product|must not: "investors"/i.test(t) && !/^Someone wants to be connected with people who match this: "[^"]*a technical cofounder/.test(t));
  check("Jordan's conditions and their words appear in no other prompt, draft or text", leaks.length === 0, leaks.map((l) => l.slice(0, 200)));
}

// ================================================================ 3. the same want without the condition, for the before/after
{
  reset();
  const jordan = addMember({ first_name: "Jordan", intent: [ask(COFOUNDER), ask(OUTSIDE)] });
  const noor = addMember({ first_name: "Noor", intent: [ask("angel checks for consumer founders", "offering")] });
  addEvent({ api_id: "evt-b", name: "Cue Night" }, [{ m: jordan }, { m: noor }]);
  W.scorer = (askText, cand) => (askText.includes(COFOUNDER) && cand.first_name === "Noor" ? { score: 95, share: true, fits: [COFOUNDER] } : { score: 0, share: false });
  await pass("evt-b");
  check("without the condition the investor is still picked (what the condition changes)", JSON.stringify(nudgedTo("evt-b", jordan)) === JSON.stringify([noor.id]));
}

// ================================================================ 4. a thin room stays silent: the bar is never lowered
{
  reset();
  const jordan = addMember({ first_name: "Jordan", intent: jordanIntent() });
  const noor = addMember({ first_name: "Noor", intent: [ask("angel checks for consumer founders", "offering")] });
  const ellis = addMember({ first_name: "Ellis", intent: [ask("a cofounder to build with", "seeking")] });
  addEvent({ api_id: "evt-thin", name: "Cue Night" }, [{ m: jordan }, { m: noor }, { m: ellis }]);
  W.scorer = (askText, cand) =>
    !askText.includes(COFOUNDER) ? { score: 0, share: false }
    : cand.first_name === "Noor" ? { score: 95, share: true, fits: [COFOUNDER], conditions: { investors: "yes", "has built a consumer product": "yes" } }
    : { score: 88, share: true, fits: [COFOUNDER], conditions: { investors: "no", "has built a consumer product": "unknown" } };
  await pass("evt-thin");
  check("nobody fits without breaking or guessing a condition: no nudge for Jordan, no text, nothing lowered to fill it", nudgedTo("evt-thin", jordan).length === 0 && !W.sent.some((s) => s.to === jordan.phone_number), { nudges: W.nudges, sent: W.sent });
}

// ================================================================ 5. a preference changes the pick, not who qualifies
{
  reset();
  const jordan = addMember({ first_name: "Jordan", intent: [{ ...ask(COFOUNDER), criteria: [crit("strong product taste", "prefer", TASTE)] }] });
  const vp = addMember({ first_name: "Avery", intent: [ask("a cofounder role", "seeking")] });
  const maker = addMember({ first_name: "Rowan", intent: [ask("a cofounder for a consumer app", "seeking")] });
  addEvent({ api_id: "evt-p", name: "Cue Night" }, [{ m: jordan }, { m: vp }, { m: maker }]);
  W.scorer = (askText, cand) =>
    !askText.includes(COFOUNDER) ? { score: 0, share: false }
    : cand.first_name === "Avery" ? { score: 78, share: true, conditions: { "strong product taste": "no" } }
    : { score: 72, share: true, conditions: { "strong product taste": "yes" } };
  await pass("evt-p");
  const rk = ranking("evt-p", jordan) as any[];
  check("the one with taste (72 + 10) is picked over the more senior one (78 - 10); both still qualify", JSON.stringify(nudgedTo("evt-p", jordan)) === JSON.stringify([maker.id]) && rk.every((x) => x.score >= WC.CONDITION_BAR), rk.map((x) => [W.members.get(x.candidate_id)?.first_name, x.score]));
}

// ================================================================ 6. the network path: the same rules on one ask
{
  reset();
  const jordan = addMember({ first_name: "Jordan", intent: jordanIntent() });
  const noor = addMember({ first_name: "Noor", intent: [ask("angel checks for consumer founders", "offering")] });
  const sam = addMember({ first_name: "Sam", intent: [ask("a cofounder for my next consumer app", "seeking")] });
  W.scorer = (_askText, cand) =>
    cand.first_name === "Noor" ? { score: 95, share: true, conditions: { investors: "yes", "has built a consumer product": "yes" } } : { score: 75, share: true, conditions: { investors: "no", "has built a consumer product": "yes" } };
  const toCand = (m: Member) => ({ user_id: m.id, goals: m.goals, activity_preferences: m.activity_preferences, intent: m.intent });
  const scored = await M.scoreAgainstStatedAsk(jordan.intent[0] as any, [toCand(noor), toCand(sam)]);
  const by = (m: Member) => scored.find((s) => s.candidate.user_id === m.id);
  check("network: the investor scores 0 with the exclusion named internally; the other keeps his score", by(noor)?.score === 0 && by(noor)?.conditions?.excluded.includes("investors") === true && by(sam)?.score === 75, scored.map((s) => [s.candidate.user_id, s.score, s.conditions]));
  const np = W.llmCalls.find((c) => c.kind === "score")?.prompt ?? "";
  check("network: the conditions are listed without want labels (one ask), and the answer shape asks for them", /\nC1, must not: "investors"/.test(np) && /"conditions": \[\]/.test(np) && /fits: \[\] \(one ask\)/.test(np), np.slice(0, 600));
  const plain = await M.scoreAgainstStatedAsk(jordan.intent[1] as any, [toCand(noor)]);
  check("network: the other want of theirs is never filtered by the first one's condition", plain[0]?.score === 95 && !plain[0]?.conditions, plain.map((s) => [s.score, s.conditions]));
}

console.log(`\n${results.total - results.failed}/${results.total} passed`);
process.exit(results.failed ? 1 : 0);
