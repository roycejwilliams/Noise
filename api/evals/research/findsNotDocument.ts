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

// ---- the captions come through the shared find-caption path; link first, then one line
const SAFE = (n: string) => `A fit for what you asked: ${n} holds the size you gave.`;
const draftFor = (bad: string[] = []): import("../../src/services/researchBrief.js").CaptionDraft => async ({ items, fix }) => ({ captions: new Map(items.map((it) => [it.url, bad.includes(it.name) && !fix ? "Rate: $125 - best in the city" : SAFE(it.name)])) });
const ctx = { firstName: "Jordan", ask: "a venue for 40", context: ["budget about 1500"] };
const four = ["Aa Hall", "Bb Loft", "Cc Room", "Dd Barn"].map((n, i) => find({ name: n, url: `https://www.peerspace.com/pages/listings/p${i}` }));
const r1 = await RB.researchMessages(four.slice(0, 2), { ...ctx, draft: draftFor() });
check("each find is its link, then one caption line", r1.messages.length === 4 && r1.messages[0] === four[0].url && r1.messages[2] === four[1].url && !/^https?:/.test(r1.messages[1]) && !/^https?:/.test(r1.messages[3]), r1.messages);
check("the facts handed to the caption writer are the find's fixed fields and what wasn't confirmed", RB.findFacts(find({ fields: RB.peerspaceFields({ hourlyPrice: null, priceRange: null, minimumHours: 3, capacity: 50, available: "unknown", evidence: "" }, { date: "2026-10-22", start: "6:00 pm" }) })).some((f) => /^Capacity: 50/.test(f)) && RB.findFacts(find({ fields: RB.peerspaceFields({ hourlyPrice: null, priceRange: null, minimumHours: 3, capacity: 50, available: "unknown", evidence: "" }, null) })).some((f) => /not confirmed on its page: rate/.test(f)));

// ---- a caption that breaks the rules (a dash, a number its facts don't have) doesn't go; the valid fourth find fills the slot
const r2 = await RB.researchMessages(four, { ...ctx, draft: async ({ items, fix }) => ({ captions: new Map(items.map((it) => [it.url, it.name === "Aa Hall" ? "Rate: $999 - best in the city" : SAFE(it.name)])) }) });
check("a caption that fails the checks drops its find, and the cap applies after the filter: three finds, the fourth fills the slot", r2.sent.length === 3 && !r2.sent.some((f) => f.name === "Aa Hall") && r2.sent.some((f) => f.name === "Dd Barn"), r2.sent.map((f) => f.name));
check("what goes out carries no dash and no raw 'unknown:' field list", r2.messages.every((m) => /^https?:/.test(m) || !/[—–]| - |unknown:/i.test(m)), r2.messages);

// ---- nothing goes without a source and a check time (filtered before the cap)
check("a find with no source link, a plain http link or no check time isn't sent", RB.sendable([find({ url: "" }), find({ url: "http://spruce.example" }), find({ checkedAt: "" }), find()]).length === 1);
const none = await RB.researchMessages([find({ url: "" })], { ...ctx, draft: draftFor() });
check("nothing valid, nothing sent", none.messages.length === 0 && none.sent.length === 0);
const noCaptions = await RB.researchMessages([find()], { ...ctx, draft: async () => null });
check("when the captions never come, nothing is sent (the task tries again)", noCaptions.messages.length === 0);
check("no more finds than the usual cap in one run", RB.BRIEF_LIMITS.maxOptions === 3);

// ---- it goes out as finds by text, never a document
const rb = src("services/researchBrief.ts");

// ---- requested work goes through a proactive pause (opt-out, safety, hours and their own rule still apply)
{
  const run0 = rb.slice(rb.indexOf("export async function runResearchBriefTask"));
  check("the research send is requested work: sendExempt(requested: true), no door", /requested: true/.test(run0) && !/door:/.test(run0.slice(run0.indexOf("const tellThenClose"), run0.indexOf("// A line held from an earlier run"))));
  const px = src("harness/proactive.ts");
  check("sendExempt: the pause holds unprompted sends, never a requested one", /if \(proactivePaused\(\) && !opts\.requested\) return \{ sent: false, reason: "proactive outreach is paused" \}/.test(px));
  process.env.PROACTIVE_PAUSED = "true";
  process.env.DATABASE_URL ||= "postgres://ci:ci@127.0.0.1:1/ci";
  const P = await import("../../src/harness/proactive.js");
  const base = { userId: "00000000-0000-4000-8000-000000000001", phoneNumber: "+15550100001", type: "task_update" as const, targetKey: "t:1", messages: ["https://example.com/x", "A fit."] };
  const unprompted = await P.sendExempt(base).catch((e: any) => ({ sent: false, reason: String(e?.message ?? e) }));
  const requested = await P.sendExempt({ ...base, requested: true }).catch((e: any) => ({ sent: false, reason: String(e?.message ?? e) }));
  check("with PROACTIVE_PAUSED an unprompted send is held, a requested result is not stopped by the pause (it goes on to the real gates)", unprompted.reason === "proactive outreach is paused" && requested.reason !== "proactive outreach is paused", { unprompted: unprompted.reason, requested: requested.reason });
  delete process.env.PROACTIVE_PAUSED;
}
const run = rb.slice(rb.indexOf("export async function runResearchBriefTask"));
check("the research task sends its finds as texts (tellThenClose of researchMessages)", /researchMessages\(finds/.test(run) && /tellThenClose\(messages, "done"/.test(run));
check("the research task never builds, renders or delivers a document", !/documentSheet|documentDelivery|googleDocs|deliverBrief|deliverAndRecord|buildBrief|renderPdf|saveTo|wantsGoogle|pendingDoc|holdBriefDoc/.test(rb), rb.match(/documentSheet|documentDelivery|googleDocs|deliverBrief|deliverAndRecord|buildBrief|renderPdf|saveTo|wantsGoogle|pendingDoc|holdBriefDoc/)?.[0]);
check("the finds are put on file (research finds, shown finds) only when the texts actually went out", /recordSentFinds/.test(run) && /next === "told" && r\.sent && record\?\.length\) await recordSentFinds/.test(run) && !/recordShownFinds\([^)]*\)\s*;\s*\n\s*const \{ recordDecision/.test(run));
check("the reply tool starts the research task and promises finds by text, not a document", /It never comes as a document/.test(src("services/capabilities.ts")) && /finds by text/.test(src("agent/loopTools.ts")) && !/will come as a document|comes as a document/.test(src("agent/loopTools.ts").slice(src("agent/loopTools.ts").indexOf("researchBrief: tool({"), src("agent/loopTools.ts").indexOf("findReaction: tool({"))));
check("the research pipeline stays: query from member state, fixed fields, freshness, ranking", /assembleQuery/.test(run) && /freshForShow/.test(run) && /rankFinds/.test(run) && /rankingSignal/.test(run) && /findVenueOptions/.test(run) && /readVenueSource/.test(rb));

console.log(`research finds, not a document: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
