// The deck judge (services/coPages/deckClaims.ts, K, Royce 2026-10-17): a verdict per line listing every fact their words don't give,
// stance can't fail (unless the line carries a figure their words don't), a missing name that's in their words, own name or goals is
// code's to drop (never beside a figure or a relationship word), and every refusal names the line and what's missing. Zero tokens:
// the judge is a fake that returns a fixed answer.
//   npx tsx evals/coPages/deckJudge.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
const DC = await import("../../src/services/coPages/deckClaims.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const fake = (answer: unknown) => { const seen: string[] = []; const j = async (p: string) => { seen.push(p); return typeof answer === "string" ? answer : JSON.stringify(answer); }; return { j, seen }; };
const pass = (n: number) => ({ n, verdict: "pass" });
const fail = (n: number, ...facts: [string, string?][]) => ({ n, verdict: "fail", facts: facts.map(([kind, missing]) => ({ kind, ...(missing !== undefined ? { missing } : {}) })) });
// One line, one answer: refused (a list with that line), passed ([]), or the check didn't run (null).
const one = (line: string, theirs: string, answer: unknown, known = "") => DC.inventedLines([line], theirs, fake(answer).j, "", "", known);
const refused = (x: any) => Array.isArray(x) && x.length === 1;
const passed = (x: any) => Array.isArray(x) && x.length === 0;

const cabin = "Cabin weekend at Mt Hood, Nov 14 to 16, eight of us, I'm cooking Saturday, hot tub, a long hike Sunday morning.";
const lines = ["A weekend that's ours", "Eight of us, Nov 14 to 16", "30% off the cabin"];

// 1. stance can't fail, unless the line carries a figure their words don't give
check("a fail the judge calls a stance is no refusal", passed(await DC.inventedLines(lines, cabin, fake({ lines: [fail(1, ["stance", "a framing"]), pass(2), pass(3)] }).j)));
for (const [line, theirs, missing] of [["30% off the cabin", cabin, "30% off"], ["Doors at 9pm on Dec 2", cabin, "Dec 2"], ["Trusted by 400 founders", "a club for founders", "400 founders"]] as const) {
  const out = await one(line, theirs, { lines: [fail(1, ["stance", missing])] });
  check(`a fact labelled stance still refuses when the line has a figure their words don't: "${line}"`, refused(out), out);
}
check("a stance line whose figures are all theirs passes", passed(await one("Eight of us, Nov 14 to 16, nothing to prove", cabin, { lines: [fail(1, ["stance", "framing"])] })));
// 2. a fact their words don't give still refuses, and the refusal names the line and what's missing
{
  const out = await DC.inventedLines(lines, cabin, fake({ lines: [pass(1), pass(2), fail(3, ["number", "30% off"])] }).j);
  check("a number their words don't give still refuses", out?.length === 1 && out[0].line === "30% off the cabin", out);
  check("the refusal says which kind of fact and what's missing, so it can go back to the writer", /number/.test(out?.[0]?.why ?? "") && /30% off/.test(out?.[0]?.why ?? ""), out);
}
// 3. a missing name: dropped when it's theirs (goals), kept when it's nowhere
{
  const royce = DC.knownFor({ firstName: "Royce", goals: [{ text: "partnering with Sequin AI for a November launch party", state: "active" }] });
  const ans = { lines: [fail(1, ["named_company", "Sequin AI"])] };
  check("a missing company name that's in their active goals is dropped by code", passed(await one("Our November launch party with Sequin AI", "Let's make the investor deck", ans, royce)));
  check("the same name in neither their words nor their goals still refuses", refused(await one("Our November launch party with Sequin AI", "Let's make the investor deck", ans, DC.knownFor({ firstName: "Royce" }))));
  check("a done goal is history: it doesn't back the name", refused(await one("Our November launch party with Sequin AI", "Let's make the investor deck", ans, DC.knownFor({ goals: [{ text: "partnering with Sequin AI for a November launch party", state: "done" }] }))));
}
// 4. their own name (the K before set: "Juno's cooking", "hosted by Odile" refused 5 of 5)
check("their own first name is never a missing name", passed(await one("Juno's cooking tonight", cabin, { lines: [fail(1, ["named_person", "Juno"])] }, DC.knownFor({ firstName: "Juno" }))));
check("hosted by their own name passes", passed(await one("A ceramics night at Heath Ceramics, hosted by Odile", "a ceramics night I'm hosting at Heath Ceramics", { lines: [fail(1, ["named_person", "Odile"])] }, DC.knownFor({ firstName: "Odile" }))));
check("someone else's name they never gave still refuses", refused(await one("Chef Marco cooks Saturday", cabin, { lines: [fail(1, ["named_person", "Marco"])] }, DC.knownFor({ firstName: "Juno" }))));
// 5. a name they gave never clears a claim about it (review of #240): relationship words, figures, other facts on the line
{
  const pitch = "I want to pitch Sequin AI on co-hosting our November launch party.";
  for (const line of ["Teaming up with Sequin AI", "Co-hosted with Sequin AI", "Backed by Sequin AI", "Sponsored by Sequin AI", "In partnership with Sequin AI", "Sequin AI confirmed a $50k sponsorship"]) {
    const out = await one(line, pitch, { lines: [fail(1, ["named_company", "Sequin AI"])] });
    check(`a name they gave doesn't clear a claim about it: "${line}"`, refused(out), out);
  }
  const why = (await one("Co-hosted with Sequin AI", pitch, { lines: [fail(1, ["named_company", "Sequin AI"])] }))?.[0]?.why ?? "";
  check("a name they gave that stands for its claim says the claim, not that the name is missing", /claim about Sequin AI/.test(why) && /co-hosted/i.test(why), why);
  check("a partnership claim is never overruled", refused(await one("Co-hosted with Sequin AI", pitch, { lines: [fail(1, ["partnership", "Sequin AI co-hosting"])] })));
  check("a name they gave doesn't clear an invented claim beside it", refused(await one("Chef Marco cooks Saturday", "Marco can't make it this time", { lines: [fail(1, ["named_person", "Marco"])] })));
  check("a line is refused unless every fact on it is cleared", refused(await one("Sequin AI brings 300 guests", pitch, { lines: [fail(1, ["named_company", "Sequin AI"], ["count", "300 guests"])] })));
  check("a cleared name doesn't clear another fact on the same line", refused(await one("Juno's cooking, the best chef in Portland", cabin, { lines: [fail(1, ["named_person", "Juno"], ["result", "best chef in Portland"])] }, DC.knownFor({ firstName: "Juno" }))));
  check("an advisor claim from a goal name refuses", refused(await one("Advised by Sequin", "make my deck", { lines: [fail(1, ["named_company", "Sequin"])] }, DC.knownFor({ goals: [{ text: "raise from Sequin Capital", state: "active" }] }))));
  check("a goal-only name stated as an investor refuses", refused(await one("Our lead investor: Sequin Capital", "make my deck", { lines: [fail(1, ["named_company", "Sequin Capital"])] }, DC.knownFor({ goals: [{ text: "raise a seed round from Sequin Capital", state: "active" }] }))));
}
// 6. what counts as the missing name: 3+ characters, whole words, in the line itself
check("a two-letter 'name' never clears a line", refused(await one("Built with OpenAI", "an AI club", { lines: [fail(1, ["named_company", "AI"])] })));
check("a two-letter word in the line is not a name either", refused(await one("Made with AI", "an AI club", { lines: [fail(1, ["named_company", "AI"])] })));
check("an empty missing name never clears a line", refused(await one("Chef Marco cooks", cabin, { lines: [fail(1, ["named_person"])] })));
check("a missing name that isn't in the line doesn't clear it", refused(await one("Built with OpenAI", "an AI club for Sequin", { lines: [fail(1, ["named_company", "Sequin"])] })));
check("a name matches across case and a possessive", DC.nameIsTheirs("Sequin AI", "partnering with sequin ai's team") && DC.nameIsTheirs("Odile's", "Odile"));
check("a name doesn't match inside another word", !DC.nameIsTheirs("Ali", "we went to Bali"));
// 7. strict shape: the old answer, both shapes, a skipped line, an unknown kind, a fail with no facts: the check didn't run (null)
check("the old {fails:[...]} answer is read as the check not running", (await DC.inventedLines(lines, cabin, fake({ fails: [{ n: 3, why: "invented discount" }] }).j)) === null);
check("an answer with both shapes is the check not running", (await DC.inventedLines(lines, cabin, fake({ fails: [{ n: 2, why: "x" }], lines: [pass(1), pass(2), pass(3)] }).j)) === null);
check("an answer that skips a line is the check not running", (await DC.inventedLines(lines, cabin, fake({ lines: [pass(1), pass(2)] }).j)) === null);
check("an unknown kind is the check not running", (await DC.inventedLines(lines, cabin, fake({ lines: [pass(1), pass(2), fail(3, ["vibe", "x"])] }).j)) === null);
check("a fail that lists no fact is the check not running", (await DC.inventedLines(lines, cabin, fake({ lines: [pass(1), pass(2), { n: 3, verdict: "fail", facts: [] }] }).j)) === null);
check("a line named twice is the check not running", (await DC.inventedLines(lines, cabin, fake({ lines: [pass(1), pass(1), pass(3)] }).j)) === null);
// 8. the prompt: plain definitions with one example each; only the lines, their words (and self/thread when given); never the goals
{
  const { j, seen } = fake({ lines: [pass(1), pass(2), pass(3)] });
  await DC.inventedLines(lines, cabin, j, "", "", "SECRET-GOAL-TEXT partnering with someone");
  const p = seen[0] ?? "";
  check("the prompt defines a stance, with an example", /A STANCE is/.test(p) && /Not another social club/.test(p), p.slice(0, 400));
  check("the prompt defines a fact, with an example", /A FACT is/.test(p) && /14 studios pay \$89 a month/.test(p));
  check("the prompt says what their words are", /THEIR WORDS means/.test(p));
  check("the prompt asks for every fact a failed line carries", /list every fact on that line/.test(p));
  check("the prompt carries their words and every line", p.includes(cabin) && lines.every((l, i) => p.includes(`${i + 1}. ${l}`)));
  check("the goals and name the overrule reads never reach the judge", !p.includes("SECRET-GOAL-TEXT"));
}

console.log(`deck judge: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
