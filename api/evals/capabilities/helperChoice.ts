// The helper-choice rule (Royce, 2026-10-18, permanent): "The situation decides what Cue looks for and which helpers run. What we
// know about a member shapes how, never which helper." The read-only plan (context-across-cue-plan.md, "Where member knowledge picks a
// helper") found five places where member knowledge picks a helper. Royce approved fixing two (the reply search's place, the room
// frame's goal fallback); this pins those two and documents the other three as known, so a change to any of them shows up here.
// Zero tokens, no database, nothing sent.
//   npx tsx evals/capabilities/helperChoice.ts
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import { existsSync, readFileSync } from "fs";

const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  }
};
const known: string[] = [];

// ================================================================ 1. the reply search (fixed): the ask decides where and what
{
  const A = await import("../../src/services/askPlace.js");
  // Member knowledge here is the profile city (and their goals). It may fill in "where" for an ask that names none; it never changes
  // where an ask that names a place looks, never adds or removes a search, and never picks the tool.
  const homes = ["San Francisco", "Sacramento", "Lisbon", null];
  const places = homes.map((home) => A.replySearchPlace({ kind: "web", words: "founder dinners in Lisbon", home, toolCity: home }));
  check("reply search: an ask that names a place looks there whatever their profile city is", places.every((p) => p.place === "Lisbon" && p.from === "words" && A.webSearchCity(p) === null), places);
  const lt = src("agent/loopTools.ts");
  const body = (name: string, next: string) => lt.slice(lt.indexOf(`    ${name}: tool({`), lt.indexOf(`    ${next}: tool({`));
  const ev = body("searchEvents", "webSearch");
  const ws = body("webSearch", "searchPosts");
  check("reply search: neither search reads their goals", !/goals/.test(ev) && !/goals/.test(ws));
  check("reply search: the profile city is read once in each, only as the home fallback handed to replySearchPlace", (ev.match(/profile\?\.city/g) ?? []).length === 1 && /home: ctx\.turn\?\.profile\?\.city \?\? null \}\)/.test(ev) && (ws.match(/profile\?\.city/g) ?? []).length === 1 && /const home = ctx\.turn\?\.profile\?\.city \?\? null;/.test(ws));
  check("reply search: what runs is the model's queries from the ask, unchanged by anything on file", /const run = \[\.\.\.new Set\(queries\.map\(\(q\) => q\.trim\(\)\.slice\(0, 90\)\)\.filter\(Boolean\)\)\]\.slice\(0, left\);/.test(ws) && /taskWebSearch\(ctx\.userId, q, \{ city: cityFor\(q\),/.test(ws) && /eventCandidates\(what, where\.place,/.test(ev));
}

// ================================================================ 2. the room frame (fixed by fix/room-frame): no ask for the night, no goal frame
// The two fixes are separate PRs. Until fix/room-frame is in (its test, evals/matching/roomFrameSituation.ts, comes with it), the
// goal fallback is listed as known here; once that test exists, the fallback must be gone.
{
  const M = await import("../../src/services/matching.js");
  const onlyGoals = [{ id: "g1", kind: "goal", status: "active", text: "Meet people building consumer social" }];
  const frame = await M.roomFrame(onlyGoals);
  const fixedThere = existsSync(new URL("../matching/roomFrameSituation.ts", import.meta.url));
  if (frame && !fixedThere) known.push("room frame: a member with no ask is framed by their newest goal (eventScoring.ts, matching.ts roomFrame); fixed by fix/room-frame");
  else check("room frame: a member with no ask for the night is not framed by a goal (the situation decides; they're asked, like anyone with no ask)", frame === null, frame);
}

// ================================================================ 3-5. known, pending Royce's answer (plan section 5, flags 2-4)
// Each is pinned as it is today, so the doc stays true: if one changes, this fails and the entry is updated (to fixed, or removed).
{
  // pending Royce's answer: the bundle composer can skip a find for fit in the same prompt that carries how they've been feeling, so
  // a mood could cut an offer (Stage 1 section 7e; read, not observed).
  const bc = src("harness/bundleComposer.ts");
  const ok = /If one of them doesn't actually fit them, skip it/.test(bc) && /HOW THEY'VE BEEN FEELING \(it shapes how you say this, never whether/.test(bc);
  check("known (pending Royce's answer): the bundle composer's fit-skip shares a prompt with the feeling block, as pinned", ok);
  if (ok) known.push("bundle composer: the fit-skip runs in the same prompt as the feeling block (harness/bundleComposer.ts)");
}
{
  // pending Royce's answer: check-ins held while they're struggling, and stop-looking notes withheld when needsCare: their state
  // decides whether a helper runs. Kept by earlier rulings (Royce 2026-09-18).
  const pr = src("harness/proactive.ts");
  const tc = src("services/turnContext.ts");
  const ok = /if \(state\.needsCare && HOLD_WHILE_STRUGGLING\.has\(c\.type\)\)/.test(pr) && /const stopNotesP = emotional\?\.needsCare \? Promise\.resolve\(\[\]/.test(tc);
  check("known (pending Royce's answer): feelings-based holds (HOLD_WHILE_STRUGGLING, stop notes on needsCare), as pinned", ok);
  if (ok) known.push("feelings-based holds: HOLD_WHILE_STRUGGLING (harness/proactive.ts) and stopNotesP on needsCare (services/turnContext.ts)");
}
{
  // pending Royce's answer: kind restraint: engagement history turns whole kinds of helper off for N days (services/kindRestraint.ts).
  const pr = src("harness/proactive.ts");
  const ok = /state\.suppressedKinds\?\.includes\(kind\)/.test(pr) && /suppressedKinds: ProactiveKind\[\];/.test(src("services/memberKnowledge.ts"));
  check("known (pending Royce's answer): kind restraint turns kinds off from engagement history, as pinned", ok);
  if (ok) known.push("kind restraint: suppressedKinds (services/memberKnowledge.ts, harness/proactive.ts)");
}

console.log(`known, allowed (documented here):\n${known.map((k) => `  - ${k}`).join("\n")}`);
console.log(`\nhelperChoice: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
