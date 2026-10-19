// The shared member-safe strip finds a linked member's name in any case, and a "User:" line is stripped like any other
// (2026-10-18, Royce's yes: "meet noor about her gallery" and "User: coffee with Noor about her Oakland gallery" got through).
// Names that are also everyday words (Rose, Will) are found only where they stand for a person. Zero tokens, no DB.
//   npx tsx evals/member/safeCase.ts
import fs from "node:fs";
const M = await import("../../src/services/memberSafeMemories.js");
const src = fs.readFileSync(new URL("../../src/services/memberSafeMemories.ts", import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };

const gone = (name: string) => `${name}, another member, came up here; their details aren't kept for this conversation.`;
// [what Cue would read, linked names, what it must become]
const cases: [string, string, string[], string][] = [
  ["lowercase name", "meet noor about her gallery", ["Noor"], gone("Noor")],
  ["a \"User:\" line", "User: coffee with Noor about her Oakland gallery", ["Noor"], gone("Noor")],
  ["all caps", "NOOR said yes", ["Noor"], gone("Noor")],
  ["lowercase possessive", "noor's gallery", ["Noor"], gone("Noor")],
  ["accented name, whole word", "José is leaving Tesla", ["José"], gone("José")],
  ["a common-word name, lowercase, as a person", "rose said yes", ["Rose"], gone("Rose")],
  ["a common-word name, capitalized", "Rose said yes. Will met her at the studio.", ["Rose", "Will"], `${gone("Rose")} ${gone("Will")}`],
  ["a common-word name after a verb that takes a person", "meet rose at the opening", ["Rose"], gone("Rose")],
  // False-positive checks.
  ["\"rose\" the verb stays", "the gallery rose in value", ["Rose"], "the gallery rose in value"],
  ["\"Will\" opening a question stays", "Will you come?", ["Will"], "Will you come?"],
  ["\"will\" the verb stays", "it will rain on Friday", ["Will"], "it will rain on Friday"],
  ["\"May I\" stays", "May I bring a friend?", ["May"], "May I bring a friend?"],
  // Not a common word, so matched wherever it stands (the accepted cost: a place that shares the name goes too).
  ["Jordan River (a name that isn't a common word) is stripped", "Jordan River trip", ["Jordan"], gone("Jordan")],
  // Accents folded on both sides, and a decomposed form read as its composed one.
  ["linked as Zoë, written Zoe", "Zoe is leaving Tesla", ["Zoë"], gone("Zoë")],
  ["linked as Zoe, written Zoë", "Zoë is leaving Tesla", ["Zoe"], gone("Zoe")],
  ["a decomposed Zoë (e + combining diaeresis)", "Zoe\u0308 is leaving Tesla", ["Zoë"], gone("Zoë")],
  ["accent folding keeps whole words", "Zoëlla Street pop-up", ["Zoë"], "Zoëlla Street pop-up"],
  // "with" takes a person.
  ["a common-word name after \"with\"", "coffee with may, she is leaving Tesla", ["May"], gone("May")],
  // The documented tradeoffs, pinned so a change to them is a choice.
  ["tradeoff: a lowercase common-word name elsewhere is kept", "saw rose at the opening", ["Rose"], "saw rose at the opening"],
  ["tradeoff: one after \"with\" that isn't the person is stripped", "a cake with rose petals", ["Rose"], gone("Rose")],
  // Their own words, unchanged: their stored texts and their turns in a call transcript.
  ["their stored texts are theirs and kept", "User said: Noor and I want coffee", ["Noor"], "User said: Noor and I want coffee"],
  ["their turn in a call transcript (\"user:\") is theirs and kept", "user: I had coffee with Noor, she's leaving Tesla", ["Noor"], "user: I had coffee with Noor, she's leaving Tesla"],
  ["a call transcript: their turn kept, Cue's turn naming her stripped", "user: I had coffee with Noor\nassistant: Noor is leaving Tesla for a grid storage startup.", ["Noor"], `user: I had coffee with Noor\n${gone("Noor")}`],
  ["a name inside another word is left alone", "Noorani Street pop-up", ["Noor"], "Noorani Street pop-up"],
  ["a name at the end of another word is left alone", "the Mansnoor Road pop-up", ["Noor"], "the Mansnoor Road pop-up"],
  ["a name they're not linked with is left alone", "meet lena about the pitch", ["Noor"], "meet lena about the pitch"],
];
for (const [label, input, names, want] of cases) {
  const got = M.safeMemory("text_exchange", input, names);
  check(`${label}: ${JSON.stringify(input)}`, got === want, { got, want });
}

// Every reader goes through the same strip: the line strip (reply context, whatCoKnows, calls, sweep), the memory strip
// (sendblue's relevance candidates, callContext) and member knowledge's (safeMemory with its own type).
const line = await M.memberSafeLine("u-test", ["Noor"]);
check("memberSafeLine: lowercase name stripped", line("Waiting on noor: wants the Oakland space by Friday") === gone("Noor"), line("Waiting on noor: wants the Oakland space by Friday"));
check("memberSafeLine: a \"User:\" line stripped", !/gallery|Oakland/i.test(line("User: coffee with Noor about her Oakland gallery") ?? ""));
const rows = await M.memberSafe("u-test", [{ content: "Co replied: noor just left Tesla and wants a cofounder.", memory_type: "text_exchange" }, { content: "User said: noor is great", memory_type: "text_exchange" }], ["Noor"]);
check("memberSafe: Cue's line naming her in lowercase cut to the history line; their own text kept", rows[0] === gone("Noor") && rows[1] === "User said: noor is great", rows);
check("member knowledge's type strips the same way", M.safeMemory("member_knowledge", "Coffee with NOOR about her gallery", ["Noor"]) === gone("Noor"));
check("each sentence on its own: one naming her goes, the rest stays", M.safeMemory("recap", "They want a caterer for 60. noor is opening a gallery in Oakland.", ["Noor"]) === `They want a caterer for 60. ${gone("Noor")}`);
check("the history line names her as given, never as written", M.safeMemory("recap", "NOOR wants the space", ["Noor"]) === gone("Noor"));

// The finder itself.
const find = M.nameFinder(["Rose", "Noor", "Sarah Hao"]);
check("finder: leftmost person wins", find("rose to the top, then noor and Rose met") === "Noor");
check("finder: a full name in any case and spacing", find("lunch with sarah  hao") === "Sarah Hao");
check("finder: no names, nothing found", M.nameFinder([])("Noor") === null && M.nameFinder([" ", "N"])("Noor") === null);

// Source: only their stored texts ("User said:", any case) and transcript turns ("user:", lowercase) are skipped.
check("source: OWN_WORDS is \"User said:\" (any case) or \"user:\" (lowercase only)", src.includes("const OWN_WORDS = { test: (line: string) => /^\\s*User said:/i.test(line) || /^\\s*user:/.test(line) };"));

console.log(`member-safe case: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
