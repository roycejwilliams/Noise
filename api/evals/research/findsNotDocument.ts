// Venue research goes back as finds by text, never a document (Royce, 2026-11-04: the research pipeline stays, only the document
// wrapper goes). Zero tokens, no DB.
//   npx tsx evals/research/findsNotDocument.ts
import fs from "node:fs";
const RB = await import("../../src/services/researchBrief.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 300)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const at = "2026-10-07T21:13:00.000Z";
const find = (over: Partial<import("../../src/services/researchBrief.js").ResearchFind> = {}) => ({
  name: "Shaws San Francisco",
  url: "https://www.peerspace.com/pages/listings/636c4558d6990c0022346e9d",
  checkedAt: at,
  reader: "scripted" as const,
  fields: RB.peerspaceFields({ hourlyPrice: 125, priceRange: null, minimumHours: 1, capacity: 50, available: "yes", evidence: "" }, { date: "2026-10-22", start: "6:00 pm" }),
  ...over,
});

// ---- the result is link, then one line, per find, in order
const msgs = RB.findMessages([find(), find({ name: "Rick and Roxys", url: "https://www.peerspace.com/pages/listings/rr1" })], "America/Los_Angeles");
check("each find is its link, then one line under it", msgs.length === 4 && msgs[0] === find().url && msgs[2] === "https://www.peerspace.com/pages/listings/rr1" && !/^https?:/.test(msgs[1]) && !/^https?:/.test(msgs[3]), msgs);
check("the line is one short text, inside the usual caption length", msgs.filter((m) => !/^https?:/.test(m)).every((m) => m.length <= 300 && !/\n/.test(m)), msgs);
check("the line says what the page said, and when it was checked", /Rate: \$125/.test(msgs[1]) && /Capacity: 50/.test(msgs[1]) && /checked [A-Z][a-z]{2} \d+/.test(msgs[1]), msgs[1]);

// ---- unknowns are said, never filled in
const unknown = RB.findMessages([find({ fields: RB.peerspaceFields({ hourlyPrice: null, priceRange: null, minimumHours: 3, capacity: null, available: "unknown", evidence: "" }, { date: "2026-10-22", start: "6:00 pm" }) })], "America/Los_Angeles");
check("an unknown rate and capacity are said as unknown, not guessed", /unknown: [^.;]*rate/i.test(unknown[1]) && /capacity/i.test(unknown[1]) && !/Rate: \$/.test(unknown[1]), unknown[1]);

// ---- nothing goes without a source and a check time
check("a find with no source link isn't sent", RB.findMessages([find({ url: "" })]).length === 0);
check("a find on a plain http link isn't sent", RB.findMessages([find({ url: "http://spruce.example" })]).length === 0);
check("a find with no check time isn't sent", RB.findMessages([find({ checkedAt: "" })]).length === 0);

// ---- the usual cap on finds
const many = RB.findMessages(Array.from({ length: 8 }, (_, i) => find({ name: `Place ${i}`, url: `https://www.peerspace.com/pages/listings/p${i}` })));
check("no more finds than the usual cap in one run", many.length === RB.BRIEF_LIMITS.maxOptions * 2 && RB.BRIEF_LIMITS.maxOptions === 3, many.length);

// ---- it goes out as finds by text, never a document
const rb = src("services/researchBrief.ts");
const run = rb.slice(rb.indexOf("export async function runResearchBriefTask"));
check("the research task sends its finds as texts (tellThenClose of findMessages)", /tellThenClose\(findMessages\(toSend, zone\)/.test(run));
check("the research task never builds, renders or delivers a document", !/documentSheet|documentDelivery|googleDocs|deliverBrief|deliverAndRecord|buildBrief|renderPdf|saveTo|wantsGoogle|pendingDoc|holdBriefDoc/.test(rb), rb.match(/documentSheet|documentDelivery|googleDocs|deliverBrief|deliverAndRecord|buildBrief|renderPdf|saveTo|wantsGoogle|pendingDoc|holdBriefDoc/)?.[0]);
check("the finds are put on file as research finds, so \"send it\" has their links", /recordResearchFinds\(task\.userId/.test(run));
check("the reply tool starts the research task and promises finds by text, not a document", /It never comes as a document/.test(src("services/capabilities.ts")) && /finds by text/.test(src("agent/loopTools.ts")) && !/will come as a document|comes as a document/.test(src("agent/loopTools.ts").slice(src("agent/loopTools.ts").indexOf("researchBrief: tool({"), src("agent/loopTools.ts").indexOf("findReaction: tool({"))));
check("the research pipeline stays: query from member state, fixed fields, freshness, ranking", /assembleQuery/.test(run) && /freshForShow/.test(run) && /rankFinds/.test(run) && /rankingSignal/.test(run) && /findVenueOptions/.test(run) && /readVenueSource/.test(rb));

console.log(`research finds, not a document: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
