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
check("\"thousands\" is a figure: a stance-labelled fail stands", refused(await one("Thousands of founders already in", "a members dinner for founders", { lines: [fail(1, ["stance", "framing"])] })));
for (const w of ["Hundreds on the waitlist", "A million reasons to come", "Dozens of hosts"]) check(`"${w}" carries a figure`, refused(await one(w, "a members dinner for founders", { lines: [fail(1, ["stance", "framing"])] })));
check("a month is backed only by the month in their words, by case", refused(await one("Launch party in May", "you may want a launch party", { lines: [fail(1, ["stance", "framing"])] })) && passed(await one("Launch party in May", "a launch party in May", { lines: [fail(1, ["stance", "framing"])] })));
check("a short month backs the month only with a day after it", passed(await one("Nov 14", "Cabin, Nov 14 to 16", { lines: [fail(1, ["stance", "framing"])] })) && refused(await one("Nov 14", "Cabin, Nov the 14th", { lines: [fail(1, ["stance", "framing"])] })));
for (const line of ["May launch party", "March opening night", "May: the first dinner"]) check(`a month opening a line is still a month: "${line}"`, refused(await one(line, "a founders dinner at mine", { lines: [fail(1, ["stance", "framing"])] })));
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
  check("a name in their active goals is never cleared by code (only their own first name is)", refused(await one("Proof: Sequin AI, November", "Let's make the investor deck", ans, royce)));
  check("a name in their own words is never cleared by code either", refused(await one("Proof: Sequin AI, November", "Our November launch with Sequin AI", ans, DC.knownFor({ firstName: "Royce" }))));
  check("a goal never backs a figure (a goal is an aim)", refused(await one("Launch in November", "make my deck", { lines: [fail(1, ["stance", "framing"])] }, royce)));
  check("the same name in neither their words nor their goals still refuses", refused(await one("Proof: Sequin AI, November", "Let's make the investor deck", ans, DC.knownFor({ firstName: "Royce" }))));
  check("a done goal is history: it doesn't back the name", refused(await one("Proof: Sequin AI, November", "Let's make the investor deck", ans, DC.knownFor({ goals: [{ text: "partnering with Sequin AI for a November launch party", state: "done" }] }))));
  check("a goal name never clears a relationship it doesn't state as done: \"launch party with\"", refused(await one("Our November launch party with Sequin AI", "Let's make the investor deck", ans, royce)));
}
// 4. their own name (the K before set: "Juno's cooking", "hosted by Odile" refused 5 of 5)
check("their own first name is never a missing name", passed(await one("Juno's cooking tonight", cabin, { lines: [fail(1, ["named_person", "Juno"])] }, DC.knownFor({ firstName: "Juno" }))));
{
  const tw = "a dinner I'm hosting; I want to pitch Sequin AI and Acme";
  const odile = DC.knownFor({ firstName: "Odile" });
  const names = (l: string): [string, string][] => [["named_person", "Odile"], ...(/Sequin/.test(l) ? [["named_company", "Sequin AI"] as [string, string]] : []), ...(/Acme/.test(l) ? [["named_company", "Acme"] as [string, string]] : [])];
  check("\"Hosted by Odile\" passes for Odile", passed(await one("Hosted by Odile", tw, { lines: [fail(1, ...names("Hosted by Odile"))] }, odile)));
  for (const line of ["Hosted by Odile and Sequin AI", "Hosted by Odile & Sequin AI", "Hosted by Odile with Acme", "Hosted by Odile + Acme", "Hosted by Odile x Acme", "Hosted by Odile, Sequin AI and Acme", "Hosted with Odile and Acme", "Hosted by Odile, sponsored by Acme"]) {
    const out = await one(line, tw, { lines: [fail(1, ...names(line))] }, odile);
    check(`hosting is exempt only when every name is theirs: "${line}"`, refused(out), out);
  }
  check("\"sponsored by\" still counts beside their own hosting", refused(await one("Hosted by Odile, sponsored by Acme", tw, { lines: [fail(1, ["named_person", "Odile"])] }, odile)));
  for (const line of ["Deal with Acme", "Acme joined", "Acme has joined the room", "Supper with Acme", "Drinks with Acme", "A night out with Acme", "Brunch with Acme", "Lunch with Acme", "Breakfast with Acme"]) {
    const out = await one(line, tw, { lines: [fail(1, ["named_company", "Acme"])] });
    check(`a relationship phrasing keeps a name they gave refused: "${line}"`, refused(out), out);
  }
  check("\"a big deal\" isn't a deal", passed(await one("Maya, a big deal in ceramics", "I'm a ceramicist", { lines: [fail(1, ["named_person", "Maya"])] }, DC.knownFor({ firstName: "Maya" }))));
  // The misses listed after the final pass now refuse: only their own first name clears, and hosting is exempt only with no other name after it.
  check("\"In the room: Acme\" refuses (Acme is in their words, not their own name)", refused(await one("In the room: Acme", tw, { lines: [fail(1, ["named_company", "Acme"])] }, odile)));
  check("\"Acme, at the table\" refuses", refused(await one("Acme, at the table", tw, { lines: [fail(1, ["named_company", "Acme"])] }, odile)));
  for (const line of ["Hosted by Odile and Acme", "Hosted by Odile & Acme", "Hosted by Odile, Sequin AI and Acme", "Hosted with Odile and Acme"]) {
    const out = await one(line, tw, { lines: [fail(1, ["named_person", "Odile"])] }, odile);
    check(`a co-host the judge didn't list still keeps hosting from being exempt: "${line}"`, refused(out), out);
  }
  check("their own hosting on a line with another name refuses (Heath Ceramics is a name)", refused(await one("A ceramics night at Heath Ceramics, hosted by Odile", "a ceramics night I'm hosting at Heath Ceramics", { lines: [fail(1, ["named_person", "Odile"])] }, odile)));
  check("a person named for a month who isn't them refuses", refused(await one("Dinner by April", tw, { lines: [fail(1, ["named_person", "April"])] }, odile)));
  check("their own name that is a month still carries the month: \"June's cooking tonight\" refuses unless they said June", refused(await one("June's cooking tonight", "my birthday dinner, I'm cooking", { lines: [fail(1, ["named_person", "June"])] }, DC.knownFor({ firstName: "June" }))));
  check("a short own first name clears (whole word)", passed(await one("Al's cooking tonight", "my birthday dinner, I'm cooking", { lines: [fail(1, ["named_person", "Al"])] }, DC.knownFor({ firstName: "Al" }))));
  for (const line of ["Odile and Acme host", "Acme and Odile host the night", "Odile & Acme present", "Odile with Acme", "Odile x Acme", "Odile Martin, ex-Google, at the table", "Odile Martin cooks", "Odile-Marie cooks", "Odile, ex-Google"]) {
    const out = await one(line, tw, { lines: [fail(1, ["named_person", "Odile"])] }, odile);
    check(`their own name never clears on a line with another name: "${line}"`, refused(out), out);
  }
  const besideWhy = (await one("Odile and Acme host", tw, { lines: [fail(1, ["named_person", "Odile"])] }, odile))?.[0]?.why ?? "";
  check("the refusal says their name is beside another name, not that their name is missing", /their own name, Odile, is on a line that names someone else/.test(besideWhy), besideWhy);
  check("their own name in any case and possessive still clears", passed(await one("ODILE's table", tw, { lines: [fail(1, ["named_person", "Odile"])] }, odile)));
  check("a capitalized common word or \"I\" is not another name", passed(await one("I cook, Odile hosts the Night", tw, { lines: [fail(1, ["named_person", "Odile"])] }, odile)));
  {
    const aims = DC.knownFor({ firstName: "Odile", goals: [{ text: "raise $500k for the studio", state: "active" }, { text: "40 members by March", state: "active" }] });
    for (const [line, facts] of [["$500k raised", [["stance", "framing"]]], ["40 members and counting", [["stance", "framing"]]], ["Sold out in March", [["stance", "framing"]]], ["Odile raised $500k", [["named_person", "Odile"]]]] as [string, [string, string][]][]) {
      const out = await one(line, "make my deck", { lines: [fail(1, ...facts)] }, aims);
      check(`a goal's figure reads as done, so it never backs one: "${line}"`, refused(out), out);
    }
  }
  for (const line of ["Odile joined the board", "Odile's deal with the club", "Odile, our first client"]) {
    const out = await one(line, tw, { lines: [fail(1, ["named_person", "Odile"])] }, odile);
    check(`a relationship word about the member themself keeps it refused: "${line}"`, refused(out), out);
  }
  check("a claim about the member themself still refuses: \"Odile joined Acme\" (judge lists only Odile)", refused(await one("Odile joined Acme", tw, { lines: [fail(1, ["named_person", "Odile"])] }, odile)));
  check("a claim about the member themself still refuses: \"Odile's deal with Acme\"", refused(await one("Odile's deal with Acme", tw, { lines: [fail(1, ["named_person", "Odile"])] }, odile)));
  check("their own first name must be in the line itself", refused(await one("made for fans of the long table", "a club", { lines: [fail(1, ["named_person", "Juno"])] }, DC.knownFor({ firstName: "Juno" }))));
}
check("hosted by their own name, on a line with another name, refuses", refused(await one("A ceramics night at Heath Ceramics, hosted by Odile", "a ceramics night I'm hosting at Heath Ceramics", { lines: [fail(1, ["named_person", "Odile"])] }, DC.knownFor({ firstName: "Odile" }))));
check("someone else's name they never gave still refuses", refused(await one("Chef Marco cooks Saturday", cabin, { lines: [fail(1, ["named_person", "Marco"])] }, DC.knownFor({ firstName: "Juno" }))));
// 5. a name they gave never clears a claim about it (review of #240): relationship words, figures, other facts on the line
{
  const pitch = "I want to pitch Sequin AI on co-hosting our November launch party.";
  for (const line of ["Teaming up with Sequin AI", "Co-hosted with Sequin AI", "Backed by Sequin AI", "Sponsored by Sequin AI", "In partnership with Sequin AI", "Sequin AI confirmed a $50k sponsorship"]) {
    const out = await one(line, pitch, { lines: [fail(1, ["named_company", "Sequin AI"])] });
    check(`a name they gave doesn't clear a claim about it: "${line}"`, refused(out), out);
  }
  const why = (await one("Co-hosted with Sequin AI", pitch, { lines: [fail(1, ["named_company", "Sequin AI"])] }))?.[0]?.why ?? "";
  check("a name they gave that stands for its claim says the claim, not that the name is missing", /says more about Sequin AI than their words do/.test(why) && /co-hosted/i.test(why) && /write the name without the claim/.test(why), why);
  const ownWords = (await one("Partnering with Sequin AI", "We're partnering with Sequin AI for the launch", { lines: [fail(1, ["named_company", "Sequin AI"])] }))?.[0]?.why ?? "";
  check("the claim wording holds when the relationship word is in their words too (no 'their words don't make')", /says more about Sequin AI/.test(ownWords) && !/don't make/.test(ownWords), ownWords);
  for (const line of ["Hosted by Sequin AI", "Presented by Sequin AI", "Powered by Sequin AI", "In collaboration with Sequin AI", "Joined by Sequin AI", "Featuring Sequin AI", "Supported by Sequin AI", "Trusted by Sequin AI", "Used by Sequin AI", "Alongside Sequin AI", "Launch party with Sequin AI", "Sequin AI is in", "Sequin AI on board", "Sequin AI says yes", "Sequin AI, our first client", "Sequin AI, a member since day one", "Endorsed by Sequin AI"]) {
    const out = await one(line, pitch, { lines: [fail(1, ["named_company", "Sequin AI"])] });
    check(`a relationship phrasing keeps a name they gave refused: "${line}"`, refused(out), out);
  }
  const sc = DC.knownFor({ goals: [{ text: "raise from Sequin Capital", state: "active" }] });
  check("a goal name that 'loves it' refuses", refused(await one("Sequin Capital loves it", "make my deck", { lines: [fail(1, ["named_company", "Sequin Capital"])] }, sc)));
  check("a goal name that 'is in the room' refuses", refused(await one("Sequin Capital is in the room", "make my deck", { lines: [fail(1, ["named_company", "Sequin Capital"])] }, sc)));
  check("a partnership claim is never overruled", refused(await one("Co-hosted with Sequin AI", pitch, { lines: [fail(1, ["partnership", "Sequin AI co-hosting"])] })));
  check("a name they gave doesn't clear an invented claim beside it", refused(await one("Chef Marco cooks Saturday", "Marco can't make it this time", { lines: [fail(1, ["named_person", "Marco"])] })));
  check("a line is refused unless every fact on it is cleared", refused(await one("Sequin AI brings 300 guests", pitch, { lines: [fail(1, ["named_company", "Sequin AI"], ["count", "300 guests"])] })));
  check("a cleared name doesn't clear another fact on the same line", refused(await one("Juno's cooking, the best chef in town", cabin, { lines: [fail(1, ["named_person", "Juno"], ["result", "best chef in town"])] }, DC.knownFor({ firstName: "Juno" }))));
  check("an advisor claim from a goal name refuses", refused(await one("Advised by Sequin", "make my deck", { lines: [fail(1, ["named_company", "Sequin"])] }, DC.knownFor({ goals: [{ text: "raise from Sequin Capital", state: "active" }] }))));
  check("a goal-only name stated as an investor refuses", refused(await one("Our lead investor: Sequin Capital", "make my deck", { lines: [fail(1, ["named_company", "Sequin Capital"])] }, DC.knownFor({ goals: [{ text: "raise a seed round from Sequin Capital", state: "active" }] }))));
}
// 6. what counts as the missing name: 3+ characters, whole words, in the line itself
check("a two-letter 'name' never clears a line", refused(await one("Built with OpenAI", "an AI club", { lines: [fail(1, ["named_company", "AI"])] })));
check("a two-letter word in the line is not a name either", refused(await one("Made with AI", "an AI club", { lines: [fail(1, ["named_company", "AI"])] })));
check("an empty missing name never clears a line", refused(await one("Chef Marco cooks", cabin, { lines: [fail(1, ["named_person"])] })));
check("a missing name that isn't in the line doesn't clear it", refused(await one("Made for OpenAI fans", "an AI club for Sequin", { lines: [fail(1, ["named_company", "Sequin"])] })));
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
