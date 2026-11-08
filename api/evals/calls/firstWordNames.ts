// A sentence's first word was never read as a name (offerGuard.ts mentionsIn), so another member's name at the start of a line passed a
// call's checks with nothing behind it: "Maya would be great for you to meet." went out while "You should meet Maya." was held (review
// of #418). Now a first word that isn't an ordinary English word (services/commonWords.ts, the en_US Hunspell dictionary) is a name like
// any other; a word the dictionary also has as a name leans to one when a verb follows it.
// Layer 1: the real check and the real proxy with a fake model stream; zero tokens.
//   npx tsx evals/calls/firstWordNames.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const P = await import("../../src/services/callLlmProxy.js");
const G = await import("../../src/services/offerGuard.js");
const W = await import("../../src/services/commonWords.js");
const E = await import("../../src/services/elevenLabsCalls.js");
const SW = await import("../../src/services/abilitySwitches.js");
SW.setSwitchesForTest({});
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };

const base = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const system = E.promptForElevenLabs(base).replace(/\{\{first_name\}\}/g, "Jordan").replace("{{context_summary}}", "Jordan is a founder in San Francisco building a voice product. New to Cue.").replace(/\{\{[a-z_]+\}\}/g, "");
const body = (their: string) => ({ model: "co", stream: true, messages: [{ role: "system", content: system }, { role: "assistant", content: "Hey Jordan, it's Cue." }, { role: "user", content: their }] });
const src = (their = "I'm stuck on the pitch for the voice thing.") => P.callSources(body(their) as any, "", "");
const text = (s: string) => [{ type: "content_block_start", index: 0, content_block: { type: "text" } }, ...(s.match(/.{1,6}/gs) ?? []).map((t) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })), { type: "content_block_stop", index: 0 }];
const turn = async (reply: string, their: string, jobClaims: boolean) => {
  const spoken: string[] = [], dropped: string[] = [];
  let n = 0;
  const stream = () => { const ev = n++ === 0 ? text(reply) : text("Tell me more."); return (async function* () { for (const e of ev) yield e as any; })(); };
  for await (const _ of P.runCallLlm(body(their) as any, { stream, clean: true, jobClaims, onSpoken: (s: string) => spoken.push(s), onDropped: (s: string, w: string) => dropped.push(`${s} | ${w}`) } as any)) {}
  return { spoken, dropped };
};

// ---- the leaks: held, and never reach the voice on either call path
const LEAKS = ["Maya would be great for you to meet.", "Maya is going to be there tonight.", "Priya knows a lot about voice products."];
for (const l of LEAKS) {
  const p = G.spokenProblem(l, src());
  check(`held when nothing backs it: ${l}`, p?.kind === "name" && p.missing.some((m) => /^(Maya|Priya)$/.test(m)), p);
  for (const jobClaims of [false, true]) {
    const r = await turn(`That's a good question. ${l}`, "Who should I talk to about the pitch?", jobClaims);
    check(`...and never said (${jobClaims ? "gpt-live" : "elevenlabs"}): ${l}`, !r.spoken.some((s) => /Maya|Priya/.test(s)) && r.dropped.some((d) => d.startsWith(l)), r);
  }
}
check("the same name mid-sentence was already held (unchanged)", G.spokenProblem("You should meet Maya.", src())?.kind === "name");
check("a possessive first word is a name too: \"Maya's going to love this.\"", G.spokenProblem("Maya's going to love this.", src())?.kind === "name");

// ---- what the member said on this call backs it
const theirs = "My friend Maya is coming tonight, and Priya knows voice better than anyone.";
for (const l of LEAKS) {
  check(`passes when they said the name: ${l}`, G.spokenProblem(l, src(theirs)) === null, G.spokenProblem(l, src(theirs)));
  const r = await turn(l, theirs, true);
  check(`...and is said whole: ${l}`, r.spoken.join(" ") === l && !r.dropped.length, r);
}
check("\"Stripe's CEO...\" passes when they said Stripe (and Ramp)", G.spokenProblem("Stripe's CEO and Ramp connected last week.", src("We heard Stripe and Ramp connected.")) === null, G.spokenProblem("Stripe's CEO and Ramp connected last week.", src("We heard Stripe and Ramp connected.")));
check("a name that isn't a word, never said, is held: \"Brex is a good fit.\"", G.spokenProblem("Brex is a good fit.", src())?.kind === "name");

// ---- ordinary openers pass
const OPENERS = [
  "Honestly, that's the hard part.", "Sure, let's do it.", "Today is a good day to send it.", "Tonight works.", "Sounds good.", "Totally fair.",
  "Actually, that changes things.", "Don't overthink it.", "Let's keep going.", "That's the hard part.", "Yeah, that tracks.", "Lol, fair.",
  "Absolutely.", "Okay, so what's next?", "Gotcha.", "Cool.", "Congrats on the raise!", "Everyone has that moment.", "Will you be there?", "Mark my words.",
  "Voice is harder than text because people interrupt.", "Timing matters more than polish.", "Pitching is hard for everyone.", "Investors want a clear story.",
  "Founders often skip this.", "Coffee sounds good.", "Summer is a slow season for this.", "Winter is quiet for events.", "Momentum is everything.", "Clarity is what they buy.", "Running a company is lonely.", "Shipping fast matters.",
  "Jordan, that's great.", "Hey Jordan.",
  // From #418's edge cases (the ones that don't depend on #418's acronym rule).
  "What would you want an investor to feel in the first ten seconds?", "If you woke up tomorrow and it just worked, what would be different?",
  "Like if you had to say it in one line, what would it be?", "APIs change, but the problem you're solving doesn't.",
  "Like what's the first thing you want to say before you get into the product?", "Like if you woke up tomorrow and you knew, what would you have figured out?",
];
for (const l of OPENERS) check(`passes: ${l}`, G.spokenProblem(l, src()) === null, G.spokenProblem(l, src()));

// ---- the rule's parts
check("an ordinary word is common in any form (pitching, totally, running, things)", ["pitching", "totally", "running", "things", "clarity", "sounds"].every((w) => W.isCommonWord(w) === true));
check("names that aren't words are not common (Maya, Priya, Brex)", ["Maya", "Priya", "Brex"].every((w) => W.isCommonWord(w) === false));
check("a word that's also a name leans to a name only when a verb follows", G.firstWordName(["Grace", "is", "coming"]) === "Grace" && G.firstWordName(["Will", "you", "be"]) === null && G.firstWordName(["Mark", "my", "words."]) === null);
check("acronyms and contractions are not read here", G.firstWordName(["APIs", "change,"]) === null && G.firstWordName(["Don't", "worry."]) === null && G.firstWordName(["I'm", "here."]) === null);
W.resetCommonWordsForTest(true);
const quiet = console.error; console.error = () => {};
check("without the word table, no first word is a name (as before): never a false hold", G.firstWordName(["Coffee", "sounds", "good."]) === null && G.spokenProblem("Maya would be great for you to meet.", src()) === null);
console.error = quiet;
W.resetCommonWordsForTest();
check("the table ships with its notice and license", ["common.txt.gz", "common-and-proper.txt.gz", "NOTICE", "LICENSE"].every((f) => fs.existsSync(new URL(`../../src/data/words/${f}`, import.meta.url))));
console.log(`firstWordNames: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
