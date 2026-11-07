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
check("follow-on: a part of a list after her is stripped, their own items stay", sm("Maya at Stripe; she is moving to Austin; I want a cofounder") === `${gone("Maya")} I want a cofounder`);
check("follow-on: nothing before her name is touched", sm("She left Stripe. I'm free Thursday.") === "She left Stripe. I'm free Thursday.");
check("follow-on: they/their/them point back right after a stripped part", ["Maya came up. They left Stripe.", "Maya came up. Their new job is at Stripe.", "Maya came up. I met them at Stripe."].every((x) => !DETAIL.test(sm(x))));
check("follow-on: \"They\" with no stripped name before it stays", sm("They want a cofounder by spring. I'm free Thursday.") === "They want a cofounder by spring. I'm free Thursday.");
// Cosmetic: the suffix is carried once, and a stray space before the comma doesn't pass as the strip's own output.
const dup = sm("Maya at Stripe, another member, came up here; their details aren't kept for this conversation.");
check("cosmetic: a name, a detail and the suffix come out with the suffix once", dup === gone("Maya"), dup);
check("cosmetic: \"Maya , another member, came up here\" gets the full line", sm("Maya , another member, came up here") === gone("Maya"));
check("idempotent on genuine output, follow-ons included", ["Maya mentioned it. She's moving to Austin. I'm free Thursday.", "Maya at Stripe; she left; I want a cofounder", `${gone("Maya")} She left Stripe.`, "Maya came up here"].every((x) => { const a = sm(x); return sm(a) === a; }));

// Drop everything after her until the text turns back to the member (2026-11-06, Royce): subject-less parts, next lines of the same paragraph
// and intervening sentences go; a bullet, header or new paragraph starts fresh; "I" ends it only when nothing in the part points back at her.
check("carry: subject-less follow-on sentences are dropped", sm("Maya came up. Left Stripe last week, moving to Austin.") === gone("Maya"));
check("carry: subject-less \"; \" items are dropped, the member's own item kept, no \".;\" join", sm("Maya came up; left Stripe; I want a cofounder") === `${gone("Maya")} I want a cofounder`);
check("carry: the next line of the same paragraph is dropped", sm("Maya came up.\nShe left Stripe.") === gone("Maya") && sm("Maya came up.\nLeft Stripe last week.") === gone("Maya"));
check("carry: an intervening sentence doesn't end it", sm("Maya came up. It rained. She left Stripe.") === gone("Maya"));
check("carry: the member speaking ends it when nothing points back (I, my, me, we)", sm("Maya came up. My week is full. Dinner is at 8.") === `${gone("Maya")} My week is full. Dinner is at 8.` && sm("Maya came up. I'm free Thursday. She left Stripe.") === `${gone("Maya")} I'm free Thursday. She left Stripe.`);
// The review's leaks: the member's "I" that carries on about her.
const speaks = ["I told him she's moving to Austin", "I think she's pregnant", "I heard she's leaving Tesla", "We talked about her divorce", "Me and her got coffee, she's pregnant", "\"I'm pregnant,\" she said.", "I told them about Stripe and Austin"];
check("leak: a member's first-person part that points back at her is dropped", speaks.every((x) => sm(`Maya came up. ${x}`) === gone("Maya") && sm(`Maya came up.\n${x}`) === gone("Maya")), speaks.map((x) => sm(`Maya came up. ${x}`)));
check("leak: Cue's own \"I\" is not the member", !/seed round/.test(sm("Co replied: I introduced you to Maya. I think she'd be great, she's raising a seed round")) && sm("Co replied: I introduced you to Maya. I think she'd be great, she's raising a seed round")=== "Cue introduced them to Maya, another member.");
check("leak: Cue's \"I\" without a pronoun is still hers in a Co line", !/seed round|Austin/.test(sm("Co replied: I introduced you to Maya. I'd say a seed round in Austin.")) && !/seed round|Austin/.test(sm("Co replied: I introduced you to Maya.\nI'd say a seed round in Austin.")));
check("leak: the probes from the #411 review", ["Marisol and I split up the company. She is moving to Austin to raise a fund with her brother.", "I already know Marisol. She is going through a divorce and moving to Austin."].every((x) => !/Austin|fund|divorce|brother/.test(M.safeMemory("recap", x, ["Marisol"]) ?? "")));
check("leak: a \"User said:\" line that named her keeps the carry into the next Cue line", sm("User said: coffee with Maya went well\nShe left Stripe.") === "User said: coffee with Maya went well" && sm("User said: I'm tired\nShe left Stripe.") === "User said: I'm tired\nShe left Stripe.");
// Over-strip shapes: a bullet, header or paragraph starts fresh, and Cue's third-person lines about the member end the carry.
const recap = "Who they are (they said):\n- Moving to Denver in March\n\nWhat is going on right now (they said it, and it is still inside its lifetime):\n- Coffee with Maya next week\n- Wants a technical cofounder\n- Training for a half marathon\n\nCue's read (inference):\n- Likes small rooms";
check("over-strip: a recap with one Maya bullet keeps the other bullets and every header", sm(recap) === recap.replace("Coffee with Maya next week", gone("Maya")), sm(recap));
check("over-strip: the member's first name or \"the member\" ends it in Cue's third-person lines", M.safeMemory("text_exchange", "[Call] Avery said they met Maya at the mixer. Maya is leaving Tesla and raising for her grid storage startup. Avery wants a technical cofounder.", ["Maya"], ["Avery"]) === `${gone("Maya")} Avery wants a technical cofounder.` && sm("Maya came up. The member wants a cofounder.") === `${gone("Maya")} The member wants a cofounder.`);
check("over-strip: a bullet crosses nothing, a blank line is a new paragraph", sm("- Maya came up\n- left Stripe\n- I want a cofounder") === `- ${gone("Maya")}\n- left Stripe\n- I want a cofounder` && sm("Maya came up.\n\nLeft Stripe.") === `${gone("Maya")}\n\nLeft Stripe.`);
check("carry: their own stored words end it when they don't name her", sm("Maya came up.\nUser said: I'm tired.\nShe left Stripe.") === `${gone("Maya")}\nUser said: I'm tired.\nShe left Stripe.`);
check("carry: a different linked member gets her own strip", M.safeMemory("recap", "Maya came up. Left Stripe. Noor came up too. Opened a gallery.", ["Maya", "Noor"]) === `${gone("Maya")} ${gone("Noor")}`);
check("carry: the strip's own output is stable", ["Maya came up; left Stripe; I want a cofounder", "- Maya came up\n- left Stripe\n- I want a cofounder", "Maya came up.\nShe left Stripe.", "Maya came up. It rained. She left Stripe.", recap, "Maya came up. I told him she's moving to Austin."].every((x) => { const a = sm(x); return sm(a) === a; }));
// Known limits: the strip starts at a linked name (a title or a nickname alone isn't found), and a part that opens with I and points at no one is the member's.
check("limit: after her name, a descriptor off any list, a surname title and non-English are all dropped", ["Maya came up. The cellist left Stripe.", "Maya came up. Ms. Chen left Stripe.", "Maya came up. Elle a quitté Stripe.", "Maya came up. Ella dejó Stripe."].every((x) => sm(x) === gone("Maya")));
check("limit: before any linked name nothing is found (\"Ms. Chen\" alone, a nickname)", sm("Ms. Chen left Stripe.") === "Ms. Chen left Stripe." && sm("Mia left Stripe.") === "Mia left Stripe." && sm("Elle a quitté Stripe. Maya came up.") === `Elle a quitté Stripe. ${gone("Maya")}`);
check("limit: a non-English member line with no pointer in English counts as the member's only if it opens with I/my/me/we", sm("Maya came up. Yo quiero un cofundador.") === gone("Maya"));

// The finder itself.
const find = M.nameFinder(["Rose", "Noor", "Sarah Hao"]);
check("finder: leftmost person wins", find("rose to the top, then noor and Rose met") === "Noor");
check("finder: a full name in any case and spacing", find("lunch with sarah  hao") === "Sarah Hao");
check("finder: no names, nothing found", M.nameFinder([])("Noor") === null && M.nameFinder([" ", "N"])("Noor") === null);

// Source: only their stored texts ("User said:", any case) and transcript turns ("user:", lowercase) are skipped.
check("source: OWN_WORDS is \"User said:\" (any case) or \"user:\" (lowercase only)", src.includes("const OWN_WORDS = { test: (line: string) => /^\\s*User said:/i.test(line) || /^\\s*user:/.test(line) };"));

console.log(`member-safe case: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
