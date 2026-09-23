// Jev vs Claude Haiku on Co's three per-text classifiers (2026-09-23, Royce:
// "test for Co as well"). Invented messages, labelled BEFORE running, no
// member data.
//   - seeking mode (services/emotionalTone.ts detectSeekingMode): do they want
//     a real answer / help deciding, not just to be heard?
//   - issue report (services/issueReports.ts classifyIssue): a problem with Co?
//   - feeling (harness/emotion.ts readTextEmotion): a real feeling, and is it
//     about Co or their life?
// Test only: nothing in Co's live path changes.
//
//   railway run --service co-test --environment dev -- npx tsx evals/jev/coCompare.ts
import "dotenv/config";
import { detectSeekingMode } from "../../src/services/emotionalTone.js";
import { classifyIssue } from "../../src/services/issueReports.js";
import { readTextEmotion } from "../../src/harness/emotion.js";

import { CASES, type Feel } from "./cases.js";

// The "Haiku now" column must be Haiku only, now that Co's checks can use Jev.
process.env.JEV_MEMBER = "off";

// ------------------------------------------------------------ Jev
let client: any = null;
async function jev(state: unknown, questions: Record<string, any>): Promise<Record<string, number> | null> {
  const key = process.env.TYPESAFE_API_KEY || process.env.jev_co;
  if (!key) return null;
  if (!client) {
    const mod: any = await import("@typesafe-ai/sdk");
    client = new mod.TypeSafeClient({ apiKey: key, timeout: 8000, retry: { maxRetries: 1 }, logLevel: "error" });
  }
  try {
    const r = await client.systemOne({ state, questions });
    return Object.fromEntries(Object.keys(questions).map((k) => [k, r.answers[k].noul]));
  } catch (e: any) {
    console.log("jev error", e?.constructor?.name, e?.status);
    return null;
  }
}
const Q = {
  solving: {
    type: "noul",
    instructions: "Right now, does `latest_message` show they clearly want a real answer or help deciding something, not just to be listened to?",
    criteria: {
      true: "They're weighing options out loud, stuck on a decision, or asking what to do (even without a question mark).",
      false: "Ordinary sharing, updates, venting, reactions, logistics, or asking Co to find or do something.",
    },
  },
  issue: {
    type: "noul",
    instructions: "Someone is testing an AI texting companion called Co. Does `latest_message` report a problem with Co itself, or say how Co should work differently?",
    criteria: {
      true: "They point out something Co did wrong or badly (sent the same thing twice, wrong or made-up info, a broken link, ignored what they said, too slow, confusing), or say how Co should behave.",
      false: "The problem is in their own life, they're just asking Co for something or changing what they want, or they're reacting normally.",
    },
  },
  feeling: {
    type: "noul",
    instructions: "Does `latest_message` carry a real feeling Co should respond to (stressed, anxious, discouraged, lonely, frustrated, excited, proud, relieved)? Use `recent_conversation`: \"fine\" after bad news isn't fine.",
    criteria: { false: "Plain logistics, greetings, short acknowledgments, or tone you can't be confident about." },
  },
  aboutCo: {
    type: "noul",
    instructions: "If `latest_message` carries a feeling, is it about Co itself (what Co found or didn't find, Co's suggestions, replies, speed, or mistakes) rather than their own life?",
  },
};

const pct = (n: number, d: number) => `${n}/${d} (${Math.round((100 * n) / d)}%)`;
const SURE_LO = 0.2, SURE_HI = 0.8;
const tally = { haiku: { s: 0, i: 0, f: 0 }, jev: { s: 0, i: 0, f: 0 }, casc: { s: 0, i: 0, f: 0 }, jevSure: { s: 0, i: 0, f: 0 }, jevSureRight: { s: 0, i: 0, f: 0 } };
let haikuMs = 0, jevMs = 0;
const misses: string[] = [];

for (const c of CASES) {
  let t = Date.now();
  const [hs, hi, hf] = await Promise.all([
    detectSeekingMode(c.msg, c.convo, "eval.jev.seeking").then((m) => m === "solving"),
    classifyIssue(c.msg, c.convo).then((r) => r !== null).catch(() => false),
    readTextEmotion(c.msg, c.convo, "eval.jev.emotion").then((e): Feel => (e ? (e.target === "co" ? "co" : "life") : "none")),
  ]);
  haikuMs += Date.now() - t;
  t = Date.now();
  const j = await jev({ latest_message: c.msg, recent_conversation: c.convo }, Q);
  jevMs += Date.now() - t;
  if (hs === c.solving) tally.haiku.s++;
  if (hi === c.issue) tally.haiku.i++;
  if (hf === c.feel) tally.haiku.f++;
  if (!j) continue;
  const js = j.solving >= 0.5, ji = j.issue >= 0.5;
  const jf: Feel = j.feeling >= 0.5 ? (j.aboutCo >= 0.5 ? "co" : "life") : "none";
  if (js === c.solving) tally.jev.s++;
  if (ji === c.issue) tally.jev.i++;
  if (jf === c.feel) tally.jev.f++;
  const sure = (p: number) => p <= SURE_LO || p >= SURE_HI;
  const cs = sure(j.solving) ? js : hs;
  const ci = sure(j.issue) ? ji : hi;
  const cf = sure(j.feeling) && (j.feeling < 0.5 || sure(j.aboutCo)) ? jf : hf;
  if (sure(j.solving)) { tally.jevSure.s++; if (js === c.solving) tally.jevSureRight.s++; }
  if (sure(j.issue)) { tally.jevSure.i++; if (ji === c.issue) tally.jevSureRight.i++; }
  if (sure(j.feeling) && (j.feeling < 0.5 || sure(j.aboutCo))) { tally.jevSure.f++; if (jf === c.feel) tally.jevSureRight.f++; }
  if (cs === c.solving) tally.casc.s++;
  if (ci === c.issue) tally.casc.i++;
  if (cf === c.feel) tally.casc.f++;
  if (js !== c.solving || ji !== c.issue || jf !== c.feel || hs !== c.solving || hi !== c.issue || hf !== c.feel)
    misses.push(`"${c.msg.slice(0, 50)}" label s=${c.solving} i=${c.issue} f=${c.feel} | haiku s=${hs} i=${hi} f=${hf} | jev s=${j.solving.toFixed(2)} i=${j.issue.toFixed(2)} f=${j.feeling.toFixed(2)}/co=${j.aboutCo.toFixed(2)}`);
}

const n = CASES.length;
console.log(`${n} labelled messages\n`);
console.log(`                     Haiku now      Jev alone      Jev when sure, else Haiku   (Jev sure on / right)`);
for (const [k, name] of [["s", "Seeking mode"], ["i", "Issue report"], ["f", "Feeling + target"]] as const) {
  console.log(`${name.padEnd(20)} ${pct(tally.haiku[k], n).padEnd(14)} ${pct(tally.jev[k], n).padEnd(14)} ${pct(tally.casc[k], n).padEnd(27)} ${tally.jevSure[k]} / ${tally.jevSureRight[k]}`);
}
console.log(`\nTime per message: Haiku (3 calls in parallel) ${Math.round(haikuMs / n)}ms, Jev (one request, 4 questions) ${Math.round(jevMs / n)}ms`);
console.log(`\nDisagreements with the labels:\n${misses.join("\n")}`);
process.exit(0);
