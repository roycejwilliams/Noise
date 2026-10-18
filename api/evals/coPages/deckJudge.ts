// The deck judge (services/coPages/deckClaims.ts, K, Royce 2026-10-17): a verdict per line, stance can't fail, a missing name that's
// in their words, own name or goals is code's to drop, and every refusal names the line and what's missing. Zero tokens: the judge
// is a fake that returns a fixed answer.
//   npx tsx evals/coPages/deckJudge.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
const DC = await import("../../src/services/coPages/deckClaims.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const fake = (answer: unknown) => { const seen: string[] = []; const j = async (p: string) => { seen.push(p); return typeof answer === "string" ? answer : JSON.stringify(answer); }; return { j, seen }; };
const v = (n: number, verdict: "pass" | "fail", kind: string, missing = "") => ({ n, verdict, kind, ...(missing ? { missing } : {}) });

const theirs = "Cabin weekend at Mt Hood, Nov 14 to 16, eight of us, I'm cooking Saturday, hot tub, a long hike Sunday morning.";
const lines = ["A weekend that's ours", "Eight of us, Nov 14 to 16", "30% off the cabin"];

// 1. stance can't fail
{
  const { j } = fake({ lines: [v(1, "fail", "stance", "a framing"), v(2, "pass", "count"), v(3, "pass", "number")] });
  const out = await DC.inventedLines(lines, theirs, j);
  check("a fail the judge calls a stance is no refusal", Array.isArray(out) && out.length === 0, out);
}
// 2. a fact their words don't give still refuses, and the refusal names the line and what's missing
{
  const { j } = fake({ lines: [v(1, "pass", "stance"), v(2, "pass", "count"), v(3, "fail", "number", "30% off")] });
  const out = await DC.inventedLines(lines, theirs, j);
  check("a number their words don't give still refuses", out?.length === 1 && out[0].line === "30% off the cabin", out);
  check("the refusal says which kind of fact and what's missing, so it can go back to the writer", /number/.test(out?.[0]?.why ?? "") && /30% off/.test(out?.[0]?.why ?? ""), out);
}
// 3. a missing name: dropped when it's in their goals, kept when it's nowhere
{
  const deck = ["Our November launch party with Sequin AI"];
  const ans = { lines: [v(1, "fail", "named_company", "Sequin AI")] };
  const withGoal = await DC.inventedLines(deck, "Let's make the investor deck", fake(ans).j, "", "", DC.knownFor({ firstName: "Royce", goals: [{ text: "partnering with Sequin AI for a November launch party", state: "active" }] }));
  check("a missing company name that's in their active goals is dropped by code", Array.isArray(withGoal) && withGoal.length === 0, withGoal);
  const nowhere = await DC.inventedLines(deck, "Let's make the investor deck", fake(ans).j, "", "", DC.knownFor({ firstName: "Royce", goals: [] }));
  check("the same name in neither their words nor their goals still refuses", nowhere?.length === 1, nowhere);
  const doneGoal = await DC.inventedLines(deck, "Let's make the investor deck", fake(ans).j, "", "", DC.knownFor({ firstName: "Royce", goals: [{ text: "partnering with Sequin AI", state: "done" }] }));
  check("a done goal is history: it doesn't back the name", doneGoal?.length === 1, doneGoal);
}
// 4. their own name (the K before set: "Juno's cooking", "hosted by Odile" refused 5 of 5)
{
  const out = await DC.inventedLines(["Juno's cooking tonight"], theirs, fake({ lines: [v(1, "fail", "named_person", "Juno")] }).j, "", "", DC.knownFor({ firstName: "Juno" }));
  check("their own first name is never a missing name", Array.isArray(out) && out.length === 0, out);
  const other = await DC.inventedLines(["Chef Marco cooks Saturday"], theirs, fake({ lines: [v(1, "fail", "named_person", "Marco")] }).j, "", "", DC.knownFor({ firstName: "Juno" }));
  check("someone else's name they never gave still refuses", other?.length === 1, other);
  const partner = await DC.inventedLines(["Partnering with Juno Labs"], theirs, fake({ lines: [v(1, "fail", "partnership", "a partnership with Juno Labs")] }).j, "", "", DC.knownFor({ firstName: "Juno" }));
  check("the overrule is for names only: a partnership claim still refuses", partner?.length === 1, partner);
}
// 5. strict shape: the old free-text answer, a skipped line or an unknown kind is the check not running (null), never a pass
{
  const old = await DC.inventedLines(lines, theirs, fake({ fails: [{ n: 3, why: "invented discount" }] }).j);
  check("the old {fails:[...]} answer is read as the check not running", old === null, old);
  const short = await DC.inventedLines(lines, theirs, fake({ lines: [v(1, "pass", "stance"), v(2, "pass", "count")] }).j);
  check("an answer that skips a line is the check not running", short === null, short);
  const odd = await DC.inventedLines(lines, theirs, fake({ lines: [v(1, "pass", "vibe"), v(2, "pass", "count"), v(3, "pass", "number")] }).j);
  check("an unknown kind is the check not running", odd === null, odd);
  const dup = await DC.inventedLines(lines, theirs, fake({ lines: [v(1, "pass", "stance"), v(1, "pass", "stance"), v(3, "pass", "number")] }).j);
  check("a line named twice is the check not running", dup === null, dup);
}
// 6. the prompt: plain definitions with one example each; only the lines, their words (and self/thread when given); never the goals
{
  const { j, seen } = fake({ lines: [v(1, "pass", "stance"), v(2, "pass", "count"), v(3, "pass", "number")] });
  await DC.inventedLines(lines, theirs, j, "", "", "SECRET-GOAL-TEXT partnering with someone");
  const p = seen[0] ?? "";
  check("the prompt defines a stance, with an example", /A STANCE is/.test(p) && /Not another social club/.test(p), p.slice(0, 400));
  check("the prompt defines a fact, with an example", /A FACT is/.test(p) && /14 studios pay \$89 a month/.test(p));
  check("the prompt says what their words are", /THEIR WORDS means/.test(p));
  check("the prompt carries their words and every line", p.includes(theirs) && lines.every((l, i) => p.includes(`${i + 1}. ${l}`)));
  check("the goals and name the overrule reads never reach the judge", !p.includes("SECRET-GOAL-TEXT"));
}
// 7. name matching is by whole words, case and possessive aside
check("a name matches across case and a possessive", DC.nameIsTheirs("Sequin AI", "partnering with sequin ai's team") && DC.nameIsTheirs("Odile's", "Odile"));
check("a name doesn't match inside another word", !DC.nameIsTheirs("Ali", "we went to Bali"));

console.log(`deck judge: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
