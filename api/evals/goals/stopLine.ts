// The one fixed "stopped looking" line (services/askRetire.ts fallbackNote), used when the written line fails: it must read cleanly
// for every shape of label fallbackLabel makes, for goals and asks alike (Royce, 2026-10-17: "reword it so it works for any goal, and
// show me the exact line before it ships"). PENDING Royce's approval, PR #236. Invented details only.
// Layer 1: pure, zero tokens, no DB.   npx tsx evals/goals/stopLine.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const A = await import("../../src/services/askRetire.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 300)}` : ""}`); } };

// Every label shape: a goal's doing (a verb, a leading "-ing", "Getting into"), a goal or ask that is a thing, request framing,
// Cue named, a leading preposition, a long one cut at the cap, and nothing at all.
const CASES: [kind: string, text: string][] = [
  ["goal: a fundraise", "Raise a $1.5M pre-seed round for Tidewell by March"],
  ["goal: a hire", "Hire a founding engineer who knows Rust"],
  ["goal: a hobby", "Getting into pottery"],
  ["goal: a move", "Move to Lisbon next spring"],
  ["goal: a launch", "Launch the Fernway beta to 200 users"],
  ["goal: meeting people", "Wants to meet more climate founders in SF"],
  ["goal: a person to find", "I want to find a cofounder for my climate startup"],
  ["goal: a leading -ing doing", "Partnering with Sequin AI on the spring pop-up"],
  ["ask: a place", "Find me a rooftop bar in North Beach for a team dinner of 12"],
  ["ask: a person-type", "Looking for a wedding photographer who does film"],
  ["ask: an event-type", "jazz nights in Oakland"],
  ["ask: request framing, Cue named", "Can you find AI events with Cue"],
  ["ask: a leading preposition", "for my sister's birthday dinner, somewhere quiet in the Mission"],
  ["ask: seeking", "Seeking a lead investor for the pre-seed round"],
  ["ask: long, cut at the cap", "Pottery classes near the Mission that run on weekday evenings after work hours"],
  ["nothing usable (empty)", ""],
  // Second review of #236 (2026-10-17): shapes the first reword broke.
  ["review: infinitive find", "To find a cofounder"],
  ["review: infinitive verb", "To meet founders"],
  ["review: about to", "About to move to Lisbon"],
  ["review: an opener", "Of course, a cofounder"],
  ["review: a bare preposition (for)", "for"],
  ["review: a bare preposition (to)", "to"],
  ["review: the search for", "The search for a cofounder"],
  ["review: a verb-looking noun", "Date night spots"],
  ["review: one word over the cap", "Supercalifragilisticexpialidociousnesslyhyperextraordinarilylongword"],
];
// The exact label each review case must come out as.
const EXPECT: Record<string, string> = {
  "To find a cofounder": "a cofounder",
  "To meet founders": "meeting founders",
  "About to move to Lisbon": "moving to Lisbon",
  "Of course, a cofounder": "a cofounder",
  "for": "",
  "to": "",
  "The search for a cofounder": "a cofounder",
  "Date night spots": "date night spots",
  "Supercalifragilisticexpialidociousnesslyhyperextraordinarilylongword": "supercalifragilisticexpialidociousnesslyhyperextraordinarilylongword".slice(0, 64),
};

const PREP = "(?:for|on|of|to|in|at|with|about|into|from|by)";
const DOUBLE_PREP = new RegExp(`\\b${PREP}\\s+${PREP}\\b`, "i");
console.log("Renders (fallbackNote, then as code carries it at the end of a reply):");
for (const [kind, text] of CASES) {
  const line = A.fallbackNote(text);
  const label = A.fallbackLabel(text);
  console.log(`  ${kind.padEnd(34)} "${text}"\n    -> ${line}.`);
  const why = (ok: boolean, what: string) => check(`${kind}: ${what}`, ok, line);
  why(/^I've paused the search on \S/.test(line), "the line's frame");
  why(/; say the word and I'll pick it back up$/.test(line), "ends on the way back, no stray period (code ends the sentence)");
  why(!/\bthings for\b/i.test(line), "no \"things for\"");
  why(!DOUBLE_PREP.test(line), "no two prepositions in a row");
  why(!/\n/.test(line) && !/\?/.test(line) && !/[—–!"]/.test(line), "one line, no question, no dash, quote or exclamation point");
  why(!/\b(?:Cue|Co)\b/.test(line) && !/\b(?:I want|wants to|seeking|find me|looking for|can you)\b/i.test(label), "never names Cue, no request framing left in the label");
  why(A.noteKeepsRules(line), "keeps the note rules (the same check a written line gets)");
  why(label.length <= A.NOTE_LABEL_CHARS && !/\s$/.test(label), "label under the cap, cut on a word");
  why(!/^I've paused the search on (?:find|meet|move|to|for|of|about|course|the search|the hunt)\b/i.test(line), "no framing word left right after \"the search on\"");
  if (text in EXPECT) why(label === EXPECT[text], `the label is exactly "${EXPECT[text]}" (got "${label}")`);
}
check("a label that comes out empty reads \"this\", never a gap", A.fallbackNote("") === "I've paused the search on this; say the word and I'll pick it back up" && A.fallbackNote("Find AI events with Cue") !== A.fallbackNote(""), A.fallbackNote(""));
check("a doing reads as a doing (raising, hiring, moving), a thing as a thing", A.fallbackLabel("Hire a founding engineer who knows Rust") === "hiring a founding engineer who knows Rust" && A.fallbackLabel("Looking for a wedding photographer who does film") === "a wedding photographer who does film");

console.log(`\nstop line: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
