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

// Follow-on sentences about a linked member (2026-11-06): a detail that refers back to her goes with her, an unrelated sentence stays.
const sm = (x: string) => M.safeMemory("recap", x, ["Maya"]) ?? "";
const DETAIL = /Stripe|Austin/;
check("follow-on: a detail after the history line is stripped", sm(`${gone("Maya")} She left Stripe.`) === gone("Maya"));
check("follow-on: \"She's moving to Austin\" after her name is stripped", sm("Maya mentioned it. She's moving to Austin.") === gone("Maya"));
check("follow-on: \"Her new job is at Stripe\" is stripped", sm("Talked about Maya. Her new job is at Stripe.") === gone("Maya"));
check("follow-on: his/him and a descriptor are stripped, a chain of them too", ["Maya came up. His new job is at Stripe.", "Maya came up. I told him about Austin.", "Maya came up. The founder left Stripe. Then she moved to Austin.", "Maya came up. And she left Stripe, honestly."].every((x) => !DETAIL.test(sm(x))));
check("follow-on: an unrelated next sentence stays", sm("Maya came up. I'm free Thursday.") === `${gone("Maya")} I'm free Thursday.`);
check("follow-on: the member's own \"I\" sentences stay, and the carry ends at the first unrelated one", sm("Maya came up. I left Stripe. She moved to Austin.") === `${gone("Maya")} I left Stripe. She moved to Austin.`);
check("follow-on: a part of a list after her is stripped, their own items stay", sm("Maya at Stripe; she is moving to Austin; I want a cofounder") === `${gone("Maya")}; I want a cofounder`);
check("follow-on: nothing before her name is touched, and the carry stays on its own line", sm("She left Stripe. I'm free Thursday.") === "She left Stripe. I'm free Thursday." && sm("Maya came up.\nShe left Stripe.").split("\n")[1] === "She left Stripe.");
check("follow-on: they/their/them point back right after a stripped part", ["Maya came up. They left Stripe.", "Maya came up. Their new job is at Stripe.", "Maya came up. I met them at Stripe."].every((x) => !DETAIL.test(sm(x))));
check("follow-on: \"They\" with no stripped name before it stays", sm("They want a cofounder by spring. I'm free Thursday.") === "They want a cofounder by spring. I'm free Thursday.");
// Cosmetic: the suffix is carried once, and a stray space before the comma doesn't pass as the strip's own output.
const dup = sm("Maya at Stripe, another member, came up here; their details aren't kept for this conversation.");
check("cosmetic: a name, a detail and the suffix come out with the suffix once", dup === gone("Maya"), dup);
check("cosmetic: \"Maya , another member, came up here\" gets the full line", sm("Maya , another member, came up here") === gone("Maya"));
check("idempotent on genuine output, follow-ons included", ["Maya mentioned it. She's moving to Austin. I'm free Thursday.", "Maya at Stripe; she left; I want a cofounder", `${gone("Maya")} She left Stripe.`, "Maya came up here"].every((x) => { const a = sm(x); return sm(a) === a; }));

// The finder itself.
const find = M.nameFinder(["Rose", "Noor", "Sarah Hao"]);
check("finder: leftmost person wins", find("rose to the top, then noor and Rose met") === "Noor");
check("finder: a full name in any case and spacing", find("lunch with sarah  hao") === "Sarah Hao");
check("finder: no names, nothing found", M.nameFinder([])("Noor") === null && M.nameFinder([" ", "N"])("Noor") === null);

// Source: only their stored texts ("User said:", any case) and transcript turns ("user:", lowercase) are skipped.
check("source: OWN_WORDS is \"User said:\" (any case) or \"user:\" (lowercase only)", src.includes("const OWN_WORDS = { test: (line: string) => /^\\s*User said:/i.test(line) || /^\\s*user:/.test(line) };"));

console.log(`member-safe case: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
