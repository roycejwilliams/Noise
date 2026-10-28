// A deck says the audience Cue assumed, beside the link (Royce, 2026-10-27, wording approved). Layer 1, pure, zero tokens.
//   npx tsx evals/review/audience.ts
import { readFileSync } from "node:fs";
const D = await import("../../src/agent/deckTools.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 300)}` : ""}`); } };
check("assumed: they never named who it's for", D.assumedAudienceLine("investors", "can you make a deck about Noise for next week", "professional") === "I pitched it at investors; say if it's for someone else.");
check("said: their own word (any form) means no line", D.assumedAudienceLine("seed investors", "a deck for the investor meeting thursday", "professional") === null);
check("'my' reads as 'your' back to them", D.assumedAudienceLine("my partners", "make me a deck", "professional") === "I pitched it at your partners; say if it's for someone else.");
check("personal decks: no line (that wording isn't approved)", D.assumedAudienceLine("my friends", "a deck for game night", "personal") === null);
check("no audience: no line", D.assumedAudienceLine(null, "make a deck", "professional") === null && D.assumedAudienceLine("the team", "make a deck", "professional") === null);
// Review of #290: what they did say is never read back as assumed; a long description isn't an audience.
check("'co-founder' said is 'co-founder' (hyphens)", D.assumedAudienceLine("my co-founder", "a deck for my co-founder", "professional") === null);
check("singular and plural are one word", D.assumedAudienceLine("event attendees", "something for the attendee", "professional") === null && D.assumedAudienceLine("partner companies", "for each company we partner with", "professional") === null);
check("a short acronym counts ('VCs' assumed, 'VC' said)", D.assumedAudienceLine("VCs", "make a deck about Noise", "professional") === "I pitched it at VCs; say if it's for someone else." && D.assumedAudienceLine("VCs", "for the vc meeting", "professional") === null);
check("a long description gets no line", D.assumedAudienceLine("the companies we're pitching next month", "make a deck", "professional") === null);
const src = readFileSync(new URL("../../src/agent/deckTools.ts", import.meta.url), "utf8");
check("makeDeck puts it in the link's one line", /const assumed = assumedAudienceLine\(input\.audience, `\$\{source\.theirs\}\\n\$\{ctx\.resolvedContent \?\? ""\}`, context\);/.test(src) && /\$\{assumed \? ` \$\{assumed\}` : ""\}\\n\$\{made\.url\}/.test(src));
console.log(`audience: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
